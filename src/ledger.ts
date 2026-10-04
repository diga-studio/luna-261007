/**
 * VaultMint fractional-cent valuation ledger for a single tokenized asset.
 *
 * Amounts are tracked in integer cents. A holder with q tokens out of N and
 * appraisal V (cents) is owed floor(V*q/N) plus possibly one extra cent:
 * exactly K = V - sum(floor(V*q_i/N)) holders with the largest remainders
 * (V*q_i mod N, ties broken by ascending holder id) receive the extra cent.
 *
 * Key facts that keep transfers cheap:
 *  - sum of remainders = N*K, and a transfer touches only two holders, each
 *    remainder moving by less than N, so K moves by at most 1 per transfer;
 *  - a holder's bonus status is "rank in the (remainder desc, id asc)
 *    ordering <= K", which an order-statistics treap answers in O(log H).
 *
 * transfer and quote are expected O(log H); only create and reappraise do
 * O(H log H) full passes. State is O(H): one map entry and one treap node
 * per holder with a positive balance. Departed holders are dropped.
 */

import { Treap } from "./treap.js";

export interface Holding {
  readonly holderId: string;
  readonly quantity: bigint;
}

export interface Quote {
  readonly quantity: bigint;
  readonly amount: bigint;
}

interface Account {
  quantity: bigint;
  /** floor(V * quantity / N) */
  base: bigint;
  /** (V * quantity) mod N */
  remainder: bigint;
}

const MIN_TOKENS = 100n;
const MAX_TOKENS = 1_000_000n;

/** Deterministic xorshift32 so treap shape (and tests) are reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

export class VaultMintLedger {
  private readonly totalTokens: bigint;
  private appraisal: bigint;
  private readonly accounts = new Map<string, Account>();
  private tree = new Treap(seededRandom(0x5eed));
  /** K: how many holders currently receive the +1 cent bonus. */
  private bonusCount = 0n;

  constructor(totalTokens: bigint, appraisalCents: bigint, holdings: readonly Holding[]) {
    if (totalTokens < MIN_TOKENS || totalTokens > MAX_TOKENS) {
      throw new RangeError("totalTokens must be within [100, 1000000]");
    }
    if (appraisalCents <= 0n) {
      throw new RangeError("appraisalCents must be a positive integer");
    }
    this.totalTokens = totalTokens;
    this.appraisal = appraisalCents;

    let sum = 0n;
    for (const holding of holdings) {
      if (holding.quantity <= 0n) {
        throw new RangeError("initial quantities must be positive integers");
      }
      if (this.accounts.has(holding.holderId)) {
        throw new Error(`duplicate holder id: ${holding.holderId}`);
      }
      sum += holding.quantity;
      const account = this.computeAccount(holding.quantity);
      this.accounts.set(holding.holderId, account);
      this.tree.insert({ remainder: account.remainder, id: holding.holderId });
      this.bonusCount -= account.base;
    }
    if (sum !== totalTokens) {
      throw new Error("initial holdings must sum to totalTokens");
    }
    this.bonusCount += this.appraisal;
  }

  transfer(from: string, to: string, quantity: bigint): void {
    if (from === to) throw new Error("from and to must differ");
    if (quantity <= 0n) throw new RangeError("quantity must be a positive integer");
    const source = this.accounts.get(from);
    if (source === undefined) throw new Error(`unknown holder: ${from}`);
    if (source.quantity < quantity) throw new Error("insufficient balance");

    this.adjustBalance(from, source, source.quantity - quantity);
    const target = this.accounts.get(to);
    this.adjustBalance(to, target, (target?.quantity ?? 0n) + quantity);
  }

  reappraise(appraisalCents: bigint): void {
    if (appraisalCents <= 0n) {
      throw new RangeError("appraisalCents must be a positive integer");
    }
    this.appraisal = appraisalCents;
    // Full O(H) recompute is allowed here: rebuild every account and the
    // ranking tree from scratch.
    const entries = [...this.accounts.entries()];
    this.accounts.clear();
    const rebuilt = new Treap(seededRandom(0x5eed));
    let baseSum = 0n;
    for (const [id, previous] of entries) {
      const account = this.computeAccount(previous.quantity);
      this.accounts.set(id, account);
      rebuilt.insert({ remainder: account.remainder, id });
      baseSum += account.base;
    }
    this.tree = rebuilt;
    this.bonusCount = appraisalCents - baseSum;
  }

  quote(holderId: string): Quote {
    const account = this.accounts.get(holderId);
    if (account === undefined) {
      return { quantity: 0n, amount: 0n };
    }
    const rank = this.tree.rankOf({ remainder: account.remainder, id: holderId });
    const bonus = BigInt(rank) <= this.bonusCount ? 1n : 0n;
    return { quantity: account.quantity, amount: account.base + bonus };
  }

  get holderCount(): number {
    return this.accounts.size;
  }

  private computeAccount(quantity: bigint): Account {
    const scaled = this.appraisal * quantity;
    return {
      quantity,
      base: scaled / this.totalTokens,
      remainder: scaled % this.totalTokens,
    };
  }

  /**
   * Move `id` to `nextQuantity`, keeping the tree, the map and the bonus
   * counter consistent. Removes the account when it reaches zero.
   */
  private adjustBalance(id: string, current: Account | undefined, nextQuantity: bigint): void {
    if (current !== undefined) {
      this.tree.erase({ remainder: current.remainder, id });
      this.bonusCount += current.base;
    }
    if (nextQuantity === 0n) {
      this.accounts.delete(id);
      return;
    }
    const next = this.computeAccount(nextQuantity);
    this.accounts.set(id, next);
    this.tree.insert({ remainder: next.remainder, id });
    this.bonusCount -= next.base;
  }
}
