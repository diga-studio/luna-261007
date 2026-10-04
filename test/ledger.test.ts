import test from "node:test";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { VaultMintLedger, Holding, Quote } from "../src/ledger.js";

/** Deterministic PRNG (mulberry32) for reproducible tests. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function randomBigInt(rand: () => number, below: bigint): bigint {
  // Uniform enough for testing; works for arbitrarily large `below`.
  const bits = below.toString(2).length;
  let value = 0n;
  for (let i = 0; i < bits; i += 30) {
    value = (value << 30n) | BigInt(Math.floor(rand() * 0x40000000));
  }
  return value % below;
}

/**
 * Independent full-recompute reference model: derives every holder's amount
 * straight from the definition (base + top-K remainders get one cent).
 */
function referenceAmounts(
  totalTokens: bigint,
  appraisal: bigint,
  holdings: ReadonlyMap<string, bigint>,
): Map<string, bigint> {
  const rows: { id: string; base: bigint; remainder: bigint }[] = [];
  let baseSum = 0n;
  for (const [id, quantity] of holdings) {
    if (quantity === 0n) continue;
    const scaled = appraisal * quantity;
    const base = scaled / totalTokens;
    const remainder = scaled % totalTokens;
    baseSum += base;
    rows.push({ id, base, remainder });
  }
  const bonusCount = appraisal - baseSum;
  rows.sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const amounts = new Map<string, bigint>();
  rows.forEach((row, index) => {
    amounts.set(row.id, row.base + (BigInt(index) < bonusCount ? 1n : 0n));
  });
  return amounts;
}

function assertConservation(
  ledger: VaultMintLedger,
  holdings: ReadonlyMap<string, bigint>,
  totalTokens: bigint,
  appraisal: bigint,
): void {
  const reference = referenceAmounts(totalTokens, appraisal, holdings);
  let quantitySum = 0n;
  let amountSum = 0n;
  for (const [id, quantity] of holdings) {
    const quote = ledger.quote(id);
    assert.equal(quote.quantity, quantity, `quantity mismatch for ${id}`);
    assert.equal(quote.amount, reference.get(id) ?? 0n, `amount mismatch for ${id}`);
    quantitySum += quote.quantity;
    amountSum += quote.amount;
  }
  assert.equal(quantitySum, totalTokens, "quantities must sum to N");
  assert.equal(amountSum, appraisal, "amounts must sum to V");
}

describe("fixed example from the spec", () => {
  it("redistributes cents for non-participants and restores on reversal", () => {
    const ledger = new VaultMintLedger(100n, 4n, [
      { holderId: "A", quantity: 10n },
      { holderId: "B", quantity: 20n },
      { holderId: "C", quantity: 30n },
      { holderId: "D", quantity: 40n },
    ]);
    assert.deepEqual(ledger.quote("A"), { quantity: 10n, amount: 0n });
    assert.deepEqual(ledger.quote("B"), { quantity: 20n, amount: 1n });
    assert.deepEqual(ledger.quote("C"), { quantity: 30n, amount: 1n });
    assert.deepEqual(ledger.quote("D"), { quantity: 40n, amount: 2n });

    // A exits entirely; C grows. D does not trade but drops from 2 to 1.
    ledger.transfer("A", "C", 10n);
    assert.deepEqual(ledger.quote("A"), { quantity: 0n, amount: 0n });
    assert.deepEqual(ledger.quote("B"), { quantity: 20n, amount: 1n });
    assert.deepEqual(ledger.quote("C"), { quantity: 40n, amount: 2n });
    assert.deepEqual(ledger.quote("D"), { quantity: 40n, amount: 1n });

    // Reversing the transfer restores every amount exactly.
    ledger.transfer("C", "A", 10n);
    assert.deepEqual(ledger.quote("A"), { quantity: 10n, amount: 0n });
    assert.deepEqual(ledger.quote("B"), { quantity: 20n, amount: 1n });
    assert.deepEqual(ledger.quote("C"), { quantity: 30n, amount: 1n });
    assert.deepEqual(ledger.quote("D"), { quantity: 40n, amount: 2n });
  });
});

describe("randomized cross-check against full recompute", () => {
  it("matches the reference model through transfers and reappraisals", () => {
    const rand = mulberry32(20261005);
    const totalTokens = 1000n;
    const holderIds = Array.from({ length: 40 }, (_, i) => `holder-${i}`);

    // Highly repetitive quantities -> many identical remainders.
    const holdings = new Map<string, bigint>();
    for (const id of holderIds) holdings.set(id, 25n);
    const initialHoldings: Holding[] = [...holdings].map(([holderId, quantity]) => ({
      holderId,
      quantity,
    }));

    // Appraisal exceeds Number.MAX_SAFE_INTEGER.
    let appraisal = BigInt(Number.MAX_SAFE_INTEGER) * 37n + 12345n;
    const ledger = new VaultMintLedger(totalTokens, appraisal, initialHoldings);
    assertConservation(ledger, holdings, totalTokens, appraisal);

    let freshCounter = 0;
    for (let step = 0; step < 4000; step++) {
      const roll = rand();
      if (roll < 0.12) {
        // Reappraise, sometimes beyond the safe-integer range.
        appraisal = 1n + randomBigInt(rand, BigInt(Number.MAX_SAFE_INTEGER) * 50n);
        ledger.reappraise(appraisal);
      } else {
        const ids = [...holdings.keys()];
        const from = ids[Math.floor(rand() * ids.length)] as string;
        const balance = holdings.get(from) as bigint;
        // Frequently empty the account so holders leave (and later rejoin).
        const quantity =
          rand() < 0.3 ? balance : 1n + randomBigInt(rand, balance);
        let to: string;
        const targetRoll = rand();
        if (targetRoll < 0.1) {
          to = `fresh-${freshCounter++}`; // brand-new holder joins
        } else if (targetRoll < 0.2 && freshCounter > 0) {
          to = `fresh-${Math.floor(rand() * freshCounter)}`;
        } else {
          to = holderIds[Math.floor(rand() * holderIds.length)] as string;
        }
        if (to === from) continue;
        ledger.transfer(from, to, quantity);
        const remaining = balance - quantity;
        if (remaining === 0n) holdings.delete(from);
        else holdings.set(from, remaining);
        holdings.set(to, (holdings.get(to) ?? 0n) + quantity);
      }
      // Verify every account after every single operation.
      assertConservation(ledger, holdings, totalTokens, appraisal);
    }

    // A departed holder must report zero and must not linger in the ledger.
    const departed = new VaultMintLedger(100n, 10n, [
      { holderId: "x", quantity: 100n },
    ]);
    departed.transfer("x", "y", 100n);
    assert.equal(departed.holderCount, 1);
    assert.deepEqual(departed.quote("x"), { quantity: 0n, amount: 0n });
  });
});

describe("scale test", () => {
  it("handles 100k holders, 20k transfers and interleaved quotes", () => {
    const rand = mulberry32(0xc0ffee);
    const totalTokens = 1_000_000n;
    const holderTotal = 100_000;
    const holdings = new Map<string, bigint>();
    const initialHoldings: Holding[] = [];
    for (let i = 0; i < holderTotal; i++) {
      const id = `h${i}`;
      holdings.set(id, 10n);
      initialHoldings.push({ holderId: id, quantity: 10n });
    }
    let appraisal = 987_654_321_123_456_789n; // > Number.MAX_SAFE_INTEGER

    const started = process.hrtime.bigint();
    const ledger = new VaultMintLedger(totalTokens, appraisal, initialHoldings);
    const created = process.hrtime.bigint();

    const liveIds: string[] = [...holdings.keys()];
    let freshCounter = 0;
    let quoteSum = 0n;
    const transferCount = 20_000;
    for (let step = 0; step < transferCount; step++) {
      if (step % 997 === 0) {
        appraisal = 1n + randomBigInt(rand, 10n ** 24n);
        ledger.reappraise(appraisal);
      }
      const fromIndex = Math.floor(rand() * liveIds.length);
      const from = liveIds[fromIndex] as string;
      const balance = holdings.get(from) as bigint;
      const quantity = rand() < 0.25 ? balance : 1n + randomBigInt(rand, balance);
      let to: string;
      if (rand() < 0.15) {
        to = `fresh-${freshCounter++}`;
      } else {
        to = liveIds[Math.floor(rand() * liveIds.length)] as string;
      }
      if (to === from) continue;
      ledger.transfer(from, to, quantity);

      const remaining = balance - quantity;
      if (remaining === 0n) {
        holdings.delete(from);
        // Swap-remove keeps liveIds dense without scanning.
        liveIds[fromIndex] = liveIds[liveIds.length - 1] as string;
        liveIds.pop();
      } else {
        holdings.set(from, remaining);
      }
      if (!holdings.has(to)) liveIds.push(to);
      holdings.set(to, (holdings.get(to) ?? 0n) + quantity);

      // Interleaved quotes against rotating, unrelated accounts.
      for (let q = 0; q < 3; q++) {
        const probe = liveIds[Math.floor(rand() * liveIds.length)] as string;
        quoteSum += ledger.quote(probe).amount;
      }

      // Periodic full verification (a per-step check would be O(H) each).
      if (step % 2000 === 1999) {
        assertConservation(ledger, holdings, totalTokens, appraisal);
      }
    }
    const transferred = process.hrtime.bigint();
    assertConservation(ledger, holdings, totalTokens, appraisal);
    const verified = process.hrtime.bigint();

    const ms = (a: bigint, b: bigint) => Number(b - a) / 1e6;
    console.log(
      `scale: create=${ms(started, created).toFixed(0)}ms ` +
        `20k transfers(+reappraisals+60k quotes)=${ms(created, transferred).toFixed(0)}ms ` +
        `final full verify=${ms(transferred, verified).toFixed(0)}ms ` +
        `holders=${ledger.holderCount} quoteSum=${quoteSum}`,
    );
    assert.ok(quoteSum > 0n, "quotes must observe real allocations");
  });
});
