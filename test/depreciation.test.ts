import { test } from "node:test";
import assert from "node:assert/strict";
import { build, bookValues, type Asset, type BookValueRequest } from "../src/index.ts";
import { referenceBookValue } from "./reference.ts";

function query(book: ReturnType<typeof build>, id: string, date: string): bigint | null {
  const [value] = bookValues(book, [{ id, date }]);
  if (value === undefined) throw new Error("missing result");
  return value;
}

test("month-end purchase: postings clamp to month end without carrying the clamp", () => {
  // P=90000, S=0, L=3, r=100%: deps 30000, 20000, then 40000 down to 0.
  const asset: Asset = {
    id: "a", purchaseDate: "2024-01-31", price: 90000, salvage: 0, lifeMonths: 3, rate: 10000,
  };
  const book = build([asset]);
  // Entry 1 booked 2024-02-29 (leap February has no 31st).
  assert.equal(query(book, "a", "2024-02-28"), 90000n);
  assert.equal(query(book, "a", "2024-02-29"), 60000n);
  // Entry 2 booked 2024-03-31: original day-of-month 31, not carried 29.
  assert.equal(query(book, "a", "2024-03-30"), 60000n);
  assert.equal(query(book, "a", "2024-03-31"), 40000n);
  // Entry 3 (final) booked 2024-04-30, landing on salvage.
  assert.equal(query(book, "a", "2024-04-29"), 40000n);
  assert.equal(query(book, "a", "2024-04-30"), 0n);
  assert.equal(query(book, "a", "2030-12-31"), 0n);
});

test("leap-day purchase: February postings clamp to the 28th in common years", () => {
  // P=1000, S=100, L=2, r=100%: dep 500 one month after purchase, then 400.
  const asset: Asset = {
    id: "leap", purchaseDate: "2024-02-29", price: 1000, salvage: 100, lifeMonths: 2, rate: 10000,
  };
  const book = build([asset]);
  assert.equal(query(book, "leap", "2024-02-28"), null); // before purchase
  assert.equal(query(book, "leap", "2024-02-29"), 1000n); // purchase day: nothing posted
  // Entry 1 booked 2024-03-29.
  assert.equal(query(book, "leap", "2024-03-28"), 1000n);
  assert.equal(query(book, "leap", "2024-03-29"), 500n);
  // Entry 2 (final) booked 2024-04-29.
  assert.equal(query(book, "leap", "2024-04-28"), 500n);
  assert.equal(query(book, "leap", "2024-04-29"), 100n);
  assert.equal(query(book, "leap", "2040-05-01"), 100n); // fixed at salvage
});

test("leap-day purchase: entry 12 clamps to 2025-02-28, entry 13 returns to the 29th", () => {
  const asset: Asset = {
    id: "leap13", purchaseDate: "2024-02-29", price: 100_000, salvage: 100, lifeMonths: 13, rate: 10000,
  };
  const book = build([asset]);
  const at = (date: string) => {
    const value = query(book, "leap13", date);
    assert.equal(value, referenceBookValue(asset, date));
    assert.ok(value !== null);
    return value;
  };
  // Entry 12 booked 2025-02-28 (2025 has no 29th): value drops exactly that day.
  const beforeFeb = at("2025-02-27");
  const onFeb = at("2025-02-28");
  assert.ok(onFeb < beforeFeb);
  // Entry 13 booked 2025-03-29: original day-of-month 29, clamp not carried.
  const beforeMar = at("2025-03-28");
  const onMar = at("2025-03-29");
  assert.ok(onMar < beforeMar);
  assert.equal(at("2025-03-29"), 100n); // final entry settles to salvage
});

test("monthly depreciation below one cent: nothing moves until the final entry settles", () => {
  // P=5, S=1, L=12, r=100%: floor(5 * 10000 / 120000) = 0 for entries 1..11.
  const asset: Asset = {
    id: "tiny", purchaseDate: "2025-03-15", price: 5, salvage: 1, lifeMonths: 12, rate: 10000,
  };
  const book = build([asset]);
  assert.equal(query(book, "tiny", "2025-03-14"), null);
  assert.equal(query(book, "tiny", "2025-04-15"), 5n); // first entry posts zero
  assert.equal(query(book, "tiny", "2026-02-15"), 5n); // eleventh entry posts zero
  assert.equal(query(book, "tiny", "2026-03-14"), 5n);
  assert.equal(query(book, "tiny", "2026-03-15"), 1n); // final entry settles to salvage
  assert.equal(query(book, "tiny", "2027-01-01"), 1n);
});

test("depreciation is capped so the book value never drops below salvage", () => {
  // r=1000%: raw dep 8333 exceeds P-S=1000, so entry 1 lands exactly on S.
  const asset: Asset = {
    id: "cap", purchaseDate: "2025-01-10", price: 10000, salvage: 9000, lifeMonths: 12, rate: 100000,
  };
  const book = build([asset]);
  assert.equal(query(book, "cap", "2025-02-09"), 10000n);
  assert.equal(query(book, "cap", "2025-02-10"), 9000n);
  assert.equal(query(book, "cap", "2025-06-10"), 9000n);
});

test("life of one month: the single entry settles to salvage", () => {
  const asset: Asset = {
    id: "one", purchaseDate: "2025-06-30", price: 1234, salvage: 34, lifeMonths: 1, rate: 20000,
  };
  const book = build([asset]);
  assert.equal(query(book, "one", "2025-06-30"), 1234n);
  assert.equal(query(book, "one", "2025-07-29"), 1234n);
  assert.equal(query(book, "one", "2025-07-30"), 34n);
});

test("bigint inputs are accepted and stay exact beyond 2^53", () => {
  const huge = 9_007_199_254_740_993n; // 2^53 + 1, not representable as a number
  const asset: Asset = {
    id: "big", purchaseDate: "2025-01-01", price: huge, salvage: 0n, lifeMonths: 2, rate: 10000,
  };
  const book = build([asset]);
  // Entry 1: floor(huge / 2) computed exactly with bigint.
  assert.equal(query(book, "big", "2025-02-01"), huge - huge / 2n);
  assert.equal(query(book, "big", "2025-03-01"), 0n);
});

test("shuffled and duplicate requests match the month-by-month reference", () => {
  const assets: Asset[] = [
    { id: "a", purchaseDate: "2024-01-31", price: 1_000_000, salvage: 50_000, lifeMonths: 24, rate: 20000 },
    { id: "b", purchaseDate: "2024-02-29", price: 777_777, salvage: 7, lifeMonths: 36, rate: 33333 },
    { id: "c", purchaseDate: "2025-03-15", price: 5, salvage: 1, lifeMonths: 12, rate: 10000 },
    { id: "d", purchaseDate: "2023-12-31", price: 100, salvage: 100, lifeMonths: 6, rate: 40000 },
  ];
  const book = build(assets);

  const dates = [
    "2023-12-30", "2024-01-31", "2024-02-28", "2024-02-29", "2024-03-01",
    "2024-03-30", "2024-03-31", "2024-04-30", "2024-12-31", "2025-02-28",
    "2025-03-01", "2025-03-15", "2025-06-30", "2026-02-28", "2026-03-15",
    "2026-03-16", "2027-02-28", "2028-01-01",
  ];
  const requests: BookValueRequest[] = [];
  for (const asset of assets) {
    for (const date of dates) {
      requests.push({ id: asset.id, date });
    }
  }
  // Duplicate every request, then shuffle deterministically (seeded PRNG).
  const duplicated = requests.concat(requests);
  let seed = 0xC0FFEE;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF;
  for (let i = duplicated.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [duplicated[i], duplicated[j]] = [duplicated[j]!, duplicated[i]!];
  }

  const expected = duplicated.map((req) => {
    const asset = assets.find((a) => a.id === req.id);
    assert.ok(asset !== undefined);
    return referenceBookValue(asset, req.date);
  });

  const actual = bookValues(book, duplicated);
  assert.deepEqual(actual, expected);

  // Batch history must not matter: re-answering a subset gives the same values.
  const subset = duplicated.filter((_, i) => i % 3 === 0);
  const again = bookValues(book, subset);
  assert.deepEqual(
    again,
    subset.map((req) => {
      const asset = assets.find((a) => a.id === req.id);
      assert.ok(asset !== undefined);
      return referenceBookValue(asset, req.date);
    }),
  );
});

test("randomized fuzz against the reference, including month-end and leap dates", () => {
  let state = 123456789;
  const next = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  const pick = <T,>(items: readonly T[]): T => {
    const item = items[Math.floor(next() * items.length)];
    assert.ok(item !== undefined);
    return item;
  };

  const assets: Asset[] = [];
  for (let i = 0; i < 40; i += 1) {
    const year = 2020 + Math.floor(next() * 10);
    const month = 1 + Math.floor(next() * 12);
    const day = pick([1, 15, 28, 29, 30, 31]);
    const dim = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const price = BigInt(Math.floor(next() * 10_000_000));
    const salvage = BigInt(Math.floor(next() * Number(price)));
    assets.push({
      id: `asset-${i}`,
      purchaseDate: `${year}-${String(month).padStart(2, "0")}-${String(Math.min(day, dim)).padStart(2, "0")}`,
      price,
      salvage,
      lifeMonths: 1 + Math.floor(next() * 48),
      rate: Math.floor(next() * 60000),
    });
  }
  const book = build(assets);

  const requests: BookValueRequest[] = [];
  for (const asset of assets) {
    for (let q = 0; q < 25; q += 1) {
      const year = 2019 + Math.floor(next() * 14);
      const month = 1 + Math.floor(next() * 12);
      const day = 1 + Math.floor(next() * 28);
      requests.push({
        id: asset.id,
        date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      });
    }
    // Always probe right around the purchase day-of-month in later months.
    const [py, pm, pd] = asset.purchaseDate.split("-").map(Number) as [number, number, number];
    for (let k = 0; k <= asset.lifeMonths + 1; k += 1) {
      const total = py! * 12 + (pm! - 1) + k;
      const y = Math.floor(total / 12);
      const m = (total % 12) + 1;
      const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const d = Math.min(pd!, dim);
      const around = [d - 1, d, d + 1].filter((x) => x >= 1 && x <= dim);
      for (const x of around) {
        requests.push({
          id: asset.id,
          date: `${y}-${String(m).padStart(2, "0")}-${String(x).padStart(2, "0")}`,
        });
      }
    }
  }
  // Shuffle with duplicates.
  const dup = requests.concat(requests.slice(0, 100));
  for (let i = dup.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [dup[i], dup[j]] = [dup[j]!, dup[i]!];
  }

  const actual = bookValues(book, dup);
  const expected = dup.map((req) => {
    const asset = assets.find((a) => a.id === req.id);
    assert.ok(asset !== undefined);
    return referenceBookValue(asset, req.date);
  });
  assert.deepEqual(actual, expected);
});

test("the built handle is immutable and building performs no queries", () => {
  const asset: Asset = {
    id: "f", purchaseDate: "2025-01-01", price: 1000, salvage: 0, lifeMonths: 2, rate: 20000,
  };
  const book = build([asset]);
  assert.ok(Object.isFrozen(book));
  const first = bookValues(book, [{ id: "f", date: "2025-02-01" }]);
  const second = bookValues(book, [{ id: "f", date: "2025-02-01" }]);
  assert.deepEqual(first, second);
  assert.throws(() => bookValues(book, [{ id: "nope", date: "2025-01-01" }]), /unknown asset id/);
});
