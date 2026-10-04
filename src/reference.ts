import type { Holding, Quote } from "./ledger";

export class ReferenceLedger {
  private readonly totalTokens: number;
  private readonly nBig: bigint;
  private appraisal: bigint;
  private readonly balances = new Map<string, number>();

  constructor(totalTokens: number, appraisalCents: bigint, holdings: ReadonlyArray<Holding>) {
    this.totalTokens = totalTokens;
    this.nBig = BigInt(totalTokens);
    this.appraisal = appraisalCents;
    for (const h of holdings) {
      this.balances.set(h.id, (this.balances.get(h.id) ?? 0) + h.quantity);
    }
  }

  transfer(from: string, to: string, quantity: number): void {
    const fromBal = this.balances.get(from);
    if (fromBal === undefined || fromBal < quantity || from === to) {
      throw new Error("invalid transfer");
    }
    if (fromBal === quantity) {
      this.balances.delete(from);
    } else {
      this.balances.set(from, fromBal - quantity);
    }
    this.balances.set(to, (this.balances.get(to) ?? 0) + quantity);
  }

  reappraise(appraisalCents: bigint): void {
    this.appraisal = appraisalCents;
  }

  quote(holderId: string): Quote {
    const q = this.balances.get(holderId);
    if (q === undefined) return { quantity: 0, amount: 0n };
    const ranked = this.rankHolders();
    const k = this.extraCount(ranked);
    let bonus = 0n;
    for (let i = 0; i < k; i++) {
      if (ranked[i]!.id === holderId) {
        bonus = 1n;
        break;
      }
    }
    return {
      quantity: q,
      amount: (this.appraisal * BigInt(q)) / this.nBig + bonus,
    };
  }

  holderIds(): string[] {
    return [...this.balances.keys()];
  }

  allQuotes(): Map<string, Quote> {
    const ranked = this.rankHolders();
    const k = this.extraCount(ranked);
    const result = new Map<string, Quote>();
    for (let i = 0; i < ranked.length; i++) {
      const r = ranked[i]!;
      result.set(r.id, { quantity: r.q, amount: r.base + (i < k ? 1n : 0n) });
    }
    return result;
  }

  totalAmount(): bigint {
    const ranked = this.rankHolders();
    const k = this.extraCount(ranked);
    let total = 0n;
    for (let i = 0; i < ranked.length; i++) {
      total += ranked[i]!.base + (i < k ? 1n : 0n);
    }
    return total;
  }

  totalQuantity(): number {
    let total = 0;
    for (const q of this.balances.values()) total += q;
    return total;
  }

  private rankHolders(): Array<{ id: string; q: number; base: bigint; rem: bigint }> {
    const ranked: Array<{ id: string; q: number; base: bigint; rem: bigint }> = [];
    for (const [id, q] of this.balances) {
      const scaled = this.appraisal * BigInt(q);
      ranked.push({ id, q, base: scaled / this.nBig, rem: scaled % this.nBig });
    }
    ranked.sort((a, b) => {
      if (a.rem !== b.rem) return a.rem > b.rem ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });
    return ranked;
  }

  private extraCount(ranked: Array<{ base: bigint }>): number {
    let sum = 0n;
    for (const r of ranked) sum += r.base;
    return Number(this.appraisal - sum);
  }
}
