import { formatUnits, formatValuation, parseUnits, VALUATION_SCALE } from './decimal';
import { TOKENS } from './types';
import type {
  KernelOptions,
  Rates,
  RejectReason,
  Token,
  TransferRejected,
  TransferResult,
  TransferSuccess,
  WalletInspection,
} from './types';

export const TREASURY = 'treasury';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const LIMIT_VALUATION = 25_000n * VALUATION_SCALE; // 25000 USDT in 1e-16 units
const MIN_FEE_UNITS = 10_000n; // 0.00010000 in 1e-8 units
const FEE_PER_MILLE = 1_000n; // fee = ceil(principal / 1000) == 0.1%

interface WindowEntry {
  committedAt: number;
  valuation: bigint; // exact 1e-16 USDT
}

interface KeyRecord {
  payload: string;
  result: TransferSuccess | TransferRejected;
}

export class NomadPayKernel {
  private readonly balances = new Map<string, Map<Token, bigint>>();
  private readonly rates = new Map<Token, bigint>();
  private readonly keys = new Map<string, Map<string, KeyRecord>>();
  private readonly history = new Map<string, WindowEntry[]>();
  private readonly now: () => number;
  private readonly beforeCommit: () => Promise<void>;

  constructor(options: KernelOptions) {
    this.now = () => options.clock.now();
    this.beforeCommit = options.beforeCommit ?? (() => Promise.resolve());
    this.setRates(options.rates);
    this.ensureWallet(TREASURY);
    for (const [wallet, balances] of Object.entries(options.initialBalances ?? {})) {
      const table = this.ensureWallet(wallet);
      for (const token of TOKENS) {
        const raw = balances[token];
        if (raw === undefined) continue;
        const units = parseUnits(raw);
        if (units === null || units < 0n) {
          throw new Error(`invalid initial balance for ${wallet}/${token}: ${raw}`);
        }
        table.set(token, (table.get(token) ?? 0n) + units);
      }
    }
  }

  async transfer(
    sender: string,
    recipient: string,
    token: Token,
    amount: string,
    key: string,
  ): Promise<TransferResult> {
    const amountUnits = parseUnits(amount);
    const payload = `${recipient}|${token}|${amountUnits === null ? amount : amountUnits.toString()}`;

    const replay = this.lookupKey(sender, key, payload);
    if (replay !== null) return replay;

    const rejection = (reason: RejectReason): TransferRejected =>
      this.recordRejection(sender, key, payload, reason);

    if (!TOKENS.includes(token)) return rejection('UNKNOWN_TOKEN');
    if (amountUnits === null || amountUnits <= 0n) return rejection('INVALID_AMOUNT');
    if (sender === recipient) return rejection('SAME_WALLET');
    if (!this.balances.has(sender) || !this.balances.has(recipient)) {
      return rejection('UNKNOWN_WALLET');
    }

    // Financial precheck; the authoritative check runs again at commit time
    // after the hook, against the state in effect then.
    const precheck = this.financialCheck(sender, token, amountUnits);
    if (precheck !== null) return rejection(precheck);

    await this.beforeCommit();

    // A concurrent attempt may have completed this key while we were paused.
    const raced = this.lookupKey(sender, key, payload);
    if (raced !== null) return raced;

    const failed = this.financialCheck(sender, token, amountUnits);
    if (failed !== null) return rejection(failed);

    return this.commit(sender, recipient, token, amountUnits, key, payload);
  }

  setRates(rates: Rates): void {
    const parsed = new Map<Token, bigint>();
    for (const token of TOKENS) {
      const units = parseUnits(rates[token]);
      if (units === null || units <= 0n) {
        throw new Error(`invalid rate for ${token}: ${rates[token]}`);
      }
      parsed.set(token, units);
    }
    // Atomic replacement: only mutate after the whole table validated.
    for (const token of TOKENS) {
      this.rates.set(token, parsed.get(token) as bigint);
    }
  }

  inspect(wallet: string): WalletInspection {
    const table = this.balances.get(wallet);
    const balances = {} as Record<Token, string>;
    for (const token of TOKENS) {
      balances[token] = formatUnits(table?.get(token) ?? 0n);
    }
    const used = this.windowUsed(wallet, this.now());
    const remaining = used >= LIMIT_VALUATION ? 0n : LIMIT_VALUATION - used;
    return {
      wallet,
      balances,
      windowUsed: formatValuation(used),
      windowRemaining: formatValuation(remaining),
    };
  }

  private ensureWallet(wallet: string): Map<Token, bigint> {
    let table = this.balances.get(wallet);
    if (table === undefined) {
      table = new Map<Token, bigint>();
      this.balances.set(wallet, table);
    }
    return table;
  }

  private lookupKey(sender: string, key: string, payload: string): TransferResult | null {
    const record = this.keys.get(sender)?.get(key);
    if (record === undefined) return null;
    if (record.payload !== payload) return { status: 'conflict', key };
    return record.result;
  }

  private recordRejection(
    sender: string,
    key: string,
    payload: string,
    reason: RejectReason,
  ): TransferRejected {
    const result: TransferRejected = { status: 'rejected', key, reason };
    this.storeKey(sender, key, { payload, result });
    return result;
  }

  private storeKey(sender: string, key: string, record: KeyRecord): void {
    let table = this.keys.get(sender);
    if (table === undefined) {
      table = new Map<string, KeyRecord>();
      this.keys.set(sender, table);
    }
    table.set(key, record);
  }

  /** Returns the rejection reason when the transfer cannot commit right now. */
  private financialCheck(sender: string, token: Token, amountUnits: bigint): RejectReason | null {
    const fee = this.feeOf(amountUnits);
    const balance = this.balances.get(sender)?.get(token) ?? 0n;
    if (balance < amountUnits + fee) return 'INSUFFICIENT_FUNDS';
    const valuation = amountUnits * (this.rates.get(token) as bigint);
    if (this.windowUsed(sender, this.now()) + valuation > LIMIT_VALUATION) {
      return 'LIMIT_EXCEEDED';
    }
    return null;
  }

  private commit(
    sender: string,
    recipient: string,
    token: Token,
    amountUnits: bigint,
    key: string,
    payload: string,
  ): TransferSuccess {
    const committedAt = this.now();
    const fee = this.feeOf(amountUnits);
    const valuation = amountUnits * (this.rates.get(token) as bigint);

    const senderTable = this.balances.get(sender) as Map<Token, bigint>;
    const recipientTable = this.balances.get(recipient) as Map<Token, bigint>;
    const treasuryTable = this.balances.get(TREASURY) as Map<Token, bigint>;
    senderTable.set(token, (senderTable.get(token) ?? 0n) - amountUnits - fee);
    recipientTable.set(token, (recipientTable.get(token) ?? 0n) + amountUnits);
    treasuryTable.set(token, (treasuryTable.get(token) ?? 0n) + fee);

    let entries = this.history.get(sender);
    if (entries === undefined) {
      entries = [];
      this.history.set(sender, entries);
    }
    entries.push({ committedAt, valuation });

    const result: TransferSuccess = {
      status: 'success',
      key,
      sender,
      recipient,
      token,
      amount: formatUnits(amountUnits),
      fee: formatUnits(fee),
      valuation: formatValuation(valuation),
      committedAt,
    };
    this.storeKey(sender, key, { payload, result });
    return result;
  }

  private feeOf(amountUnits: bigint): bigint {
    const proportional = (amountUnits + FEE_PER_MILLE - 1n) / FEE_PER_MILLE;
    return proportional > MIN_FEE_UNITS ? proportional : MIN_FEE_UNITS;
  }

  private windowUsed(sender: string, at: number): bigint {
    const entries = this.history.get(sender);
    if (entries === undefined) return 0n;
    let used = 0n;
    for (const entry of entries) {
      if (entry.committedAt > at - WINDOW_MS && entry.committedAt <= at) {
        used += entry.valuation;
      }
    }
    return used;
  }
}
