/** Supported tokens. */
export type Token = 'BTC' | 'ETH' | 'USDT' | 'SOL' | 'XRP';

export const TOKENS: readonly Token[] = ['BTC', 'ETH', 'USDT', 'SOL', 'XRP'];

/** A wallet is identified by a user id; the treasury is a shared system wallet. */
export type WalletId = string;

export const TREASURY: WalletId = '__treasury__';

/** Decimal string with up to 8 fractional digits, e.g. "1.50000000". */
export type DecimalString = string;

/** Token -> USDT rate table. Every token must be present. */
export type RateTable = Record<Token, DecimalString>;

/** Per-token balances. */
export type BalanceTable = Record<Token, DecimalString>;

/** Monotonic millisecond clock; may only move forward. */
export interface Clock {
  now(): number;
}

/**
 * Async hook awaited exactly once per new idempotency key, after the
 * pre-check passes and before any financial state changes. It only ever
 * resolves normally; the commit decision is re-evaluated after it returns.
 */
export type BeforeCommitHook = () => Promise<void>;

export interface KernelOptions {
  /** Initial balances per user wallet. Treasury starts empty unless provided. */
  initialBalances: Record<WalletId, Partial<Record<Token, DecimalString>>>;
  /** Initial token -> USDT rates. */
  rates: RateTable;
  clock: Clock;
  beforeCommit: BeforeCommitHook;
}

export type RejectReason =
  | 'INSUFFICIENT_FUNDS'
  | 'LIMIT_EXCEEDED'
  | 'KEY_CONFLICT'
  | 'INVALID_AMOUNT'
  | 'INVALID_TOKEN'
  | 'SAME_WALLET';

export interface TransferSuccess {
  status: 'success';
  /** Token of the transfer (echoed for convenience). */
  token: Token;
  /** Principal amount as a canonical 8-decimal string. */
  amount: DecimalString;
  /** Fee charged to the sender, canonical 8-decimal string. */
  fee: DecimalString;
  /** Exact USDT valuation fixed at commit time (principal * rate at commit). */
  valuationUsdt: DecimalString;
  /** Commit timestamp in milliseconds. */
  committedAt: number;
}

export interface TransferRejected {
  status: 'rejected';
  reason: RejectReason;
}

export type TransferResult = TransferSuccess | TransferRejected;

export interface WalletInspection {
  /** Per-token balances as canonical 8-decimal strings. */
  balances: BalanceTable;
  /**
   * Sum of exact USDT valuations of this wallet's successful transfers
   * with commit time in (now - 24h, now]. Zero for the treasury.
   */
  rollingLimitUsedUsdt: DecimalString;
  /** Hard rolling cap, always "25000". */
  rollingLimitCapUsdt: DecimalString;
}
