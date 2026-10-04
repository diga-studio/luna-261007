import {
  exactProduct,
  feeOf,
  formatProduct,
  formatUnits,
  isValidDecimal,
  parseUnits,
  PRODUCT_SCALE,
} from './decimal.js';
import type {
  BeforeCommitHook,
  Clock,
  KernelOptions,
  RateTable,
  Token,
  TransferResult,
  WalletId,
  WalletInspection,
} from './types.js';
import { TOKENS, TREASURY } from './types.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const LIMIT_PRODUCT = 25_000n * PRODUCT_SCALE; // 25000 USDT in exact product units

interface Payload {
  recipient: WalletId;
  token: Token;
  /** Parsed units; 0n when the raw amount is not a valid positive decimal. */
  amountUnits: bigint;
  /** Canonical binding for idempotency: normalized amount, or the raw string when invalid. */
  amountKey: string;
}

interface KeyEntry {
  payload: Payload;
  result: Promise<TransferResult>;
}

interface LedgerRecord {
  committedAt: number;
  valuationProduct: bigint;
}

/**
 * NomadPay rolling-limit transfer kernel.
 *
 * In-process, single-writer library. Financial invariants:
 *  - no negative balances, no value created or destroyed;
 *  - a successful transfer debits sender (principal + fee), credits
 *    recipient (principal) and treasury (fee) atomically;
 *  - rejections never touch financial state;
 *  - per-sender rolling 24h window of exact USDT valuations <= 25000 USDT;
 *  - idempotency keys are scoped per sender and bound to recipient+token+amount.
 */
export class NomadPayKernel {
  private readonly balances = new Map<WalletId, Map<Token, bigint>>();
  private rates = new Map<Token, bigint>();
  private readonly clock: Clock;
  private readonly beforeCommit: BeforeCommitHook;
  private readonly ledger = new Map<WalletId, LedgerRecord[]>();
  private readonly keys = new Map<WalletId, Map<string, KeyEntry>>();

  constructor(options: KernelOptions) {
    this.clock = options.clock;
    this.beforeCommit = options.beforeCommit;
    this.rates = NomadPayKernel.parseRates(options.rates);
    for (const [wallet, table] of Object.entries(options.initialBalances)) {
      for (const token of TOKENS) {
        const raw = table[token];
        if (raw === undefined) continue;
        if (!isValidDecimal(raw)) {
          throw new Error(`invalid initial balance for ${wallet} ${token}: ${raw}`);
        }
        this.setBalance(wallet, token, parseUnits(raw));
      }
    }
  }

  async transfer(
    sender: WalletId,
    recipient: WalletId,
    token: Token,
    amount: string,
    key: string,
  ): Promise<TransferResult> {
    // Everything up to the first await is synchronous, so concurrent retries
    // with the same key always observe the registered entry.
    const payload = NomadPayKernel.makePayload(recipient, token, amount);
    const validation = NomadPayKernel.validate(sender, payload);
    if (validation !== null) {
      return this.remember(sender, key, payload, validation);
    }

    const existing = this.keys.get(sender)?.get(key);
    if (existing !== undefined) {
      return NomadPayKernel.samePayload(existing.payload, payload)
        ? existing.result
        : { status: 'rejected', reason: 'KEY_CONFLICT' };
    }

    const precheck = this.judge(sender, payload);
    if (precheck !== null) {
      return this.remember(sender, key, payload, precheck);
    }

    const entry: KeyEntry = { payload, result: this.commit(sender, payload) };
    let senderKeys = this.keys.get(sender);
    if (senderKeys === undefined) {
      senderKeys = new Map();
      this.keys.set(sender, senderKeys);
    }
    senderKeys.set(key, entry);
    return entry.result;
  }

  setRates(rates: RateTable): void {
    this.rates = NomadPayKernel.parseRates(rates); // validate fully, then swap atomically
  }

  inspect(wallet: WalletId): WalletInspection {
    const balances = {} as Record<Token, string>;
    for (const token of TOKENS) {
      balances[token] = formatUnits(this.balanceOf(wallet, token));
    }
    return {
      balances,
      rollingLimitUsedUsdt: formatProduct(this.windowUsage(wallet, this.clock.now())),
      rollingLimitCapUsdt: '25000',
    };
  }

  private static makePayload(recipient: WalletId, token: Token, amount: string): Payload {
    const valid = isValidDecimal(amount);
    const amountUnits = valid ? parseUnits(amount) : 0n;
    return {
      recipient,
      token,
      amountUnits,
      amountKey: valid ? formatUnits(amountUnits) : amount,
    };
  }

  private static samePayload(a: Payload, b: Payload): boolean {
    return a.recipient === b.recipient && a.token === b.token && a.amountKey === b.amountKey;
  }

  /** Validate inputs; returns a rejection or null when valid. */
  private static validate(sender: WalletId, payload: Payload): TransferResult | null {
    if (!TOKENS.includes(payload.token)) {
      return { status: 'rejected', reason: 'INVALID_TOKEN' };
    }
    if (sender === payload.recipient || sender === TREASURY || payload.recipient === TREASURY) {
      return { status: 'rejected', reason: 'SAME_WALLET' };
    }
    if (payload.amountUnits <= 0n) {
      return { status: 'rejected', reason: 'INVALID_AMOUNT' };
    }
    return null;
  }

  /** Funds + rolling-limit judgement against current state; null means pass. */
  private judge(sender: WalletId, payload: Payload): TransferResult | null {
    const feeUnits = feeOf(payload.amountUnits);
    if (this.balanceOf(sender, payload.token) < payload.amountUnits + feeUnits) {
      return { status: 'rejected', reason: 'INSUFFICIENT_FUNDS' };
    }
    const now = this.clock.now();
    const valuation = exactProduct(payload.amountUnits, this.rateOf(payload.token));
    if (this.windowUsage(sender, now) + valuation > LIMIT_PRODUCT) {
      return { status: 'rejected', reason: 'LIMIT_EXCEEDED' };
    }
    return null;
  }

  /** Commit phase: runs after beforeCommit resolves, re-judges with fresh state. */
  private async commit(sender: WalletId, payload: Payload): Promise<TransferResult> {
    await this.beforeCommit();
    const verdict = this.judge(sender, payload);
    if (verdict !== null) {
      return verdict;
    }
    const now = this.clock.now();
    const feeUnits = feeOf(payload.amountUnits);
    const valuation = exactProduct(payload.amountUnits, this.rateOf(payload.token));
    this.addBalance(sender, payload.token, -(payload.amountUnits + feeUnits));
    this.addBalance(payload.recipient, payload.token, payload.amountUnits);
    this.addBalance(TREASURY, payload.token, feeUnits);
    let records = this.ledger.get(sender);
    if (records === undefined) {
      records = [];
      this.ledger.set(sender, records);
    }
    records.push({ committedAt: now, valuationProduct: valuation });
    return {
      status: 'success',
      token: payload.token,
      amount: formatUnits(payload.amountUnits),
      fee: formatUnits(feeUnits),
      valuationUsdt: formatProduct(valuation),
      committedAt: now,
    };
  }

  /** Memoize an immediately-known rejection under a fresh key. */
  private remember(
    sender: WalletId,
    key: string,
    payload: Payload,
    result: TransferResult,
  ): TransferResult {
    let senderKeys = this.keys.get(sender);
    if (senderKeys === undefined) {
      senderKeys = new Map();
      this.keys.set(sender, senderKeys);
    }
    const existing = senderKeys.get(key);
    if (existing !== undefined) {
      return NomadPayKernel.samePayload(existing.payload, payload)
        ? result
        : { status: 'rejected', reason: 'KEY_CONFLICT' };
    }
    senderKeys.set(key, { payload, result: Promise.resolve(result) });
    return result;
  }

  /** Sum of exact valuations with commit time in (now - 24h, now]. */
  private windowUsage(sender: WalletId, now: number): bigint {
    const records = this.ledger.get(sender);
    if (records === undefined) return 0n;
    let sum = 0n;
    for (const record of records) {
      if (record.committedAt > now - WINDOW_MS && record.committedAt <= now) {
        sum += record.valuationProduct;
      }
    }
    return sum;
  }

  private balanceOf(wallet: WalletId, token: Token): bigint {
    return this.balances.get(wallet)?.get(token) ?? 0n;
  }

  private setBalance(wallet: WalletId, token: Token, units: bigint): void {
    let table = this.balances.get(wallet);
    if (table === undefined) {
      table = new Map();
      this.balances.set(wallet, table);
    }
    table.set(token, units);
  }

  private addBalance(wallet: WalletId, token: Token, delta: bigint): void {
    this.setBalance(wallet, token, this.balanceOf(wallet, token) + delta);
  }

  private rateOf(token: Token): bigint {
    const rate = this.rates.get(token);
    if (rate === undefined) {
      throw new Error(`missing rate for ${token}`);
    }
    return rate;
  }

  private static parseRates(rates: RateTable): Map<Token, bigint> {
    const parsed = new Map<Token, bigint>();
    for (const token of TOKENS) {
      const raw = rates[token];
      if (raw === undefined || !isValidDecimal(raw) || parseUnits(raw) <= 0n) {
        throw new Error(`invalid rate for ${token}: ${String(raw)}`);
      }
      parsed.set(token, parseUnits(raw));
    }
    return parsed;
  }
}
