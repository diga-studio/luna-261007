/** Supported tokens. */
export type Token = 'BTC' | 'ETH' | 'USDT' | 'SOL' | 'XRP';

export const TOKENS: readonly Token[] = ['BTC', 'ETH', 'USDT', 'SOL', 'XRP'];

/** Balances: token -> decimal string with 8 fractional digits. */
export type Balances = Partial<Record<Token, string>>;

/** Exchange rates: token -> USDT price per 1 token, 8-decimal string. */
export type Rates = Record<Token, string>;

export interface Clock {
  /** Current time in milliseconds; never moves backwards. */
  now(): number;
}

export interface KernelOptions {
  /** Initial balances per wallet id (user ids). Treasury starts empty. */
  initialBalances?: Record<string, Balances>;
  /** Initial USDT rates for every token. */
  rates: Rates;
  /** Monotonic millisecond clock. */
  clock: Clock;
  /** Async hook awaited once per new key after precheck, before commit. */
  beforeCommit?: () => Promise<void>;
}

export type RejectReason =
  | 'INVALID_AMOUNT'
  | 'UNKNOWN_TOKEN'
  | 'SAME_WALLET'
  | 'UNKNOWN_WALLET'
  | 'INSUFFICIENT_FUNDS'
  | 'LIMIT_EXCEEDED';

export interface TransferSuccess {
  status: 'success';
  key: string;
  sender: string;
  recipient: string;
  token: Token;
  /** Principal as 8-decimal string. */
  amount: string;
  /** Fee as 8-decimal string. */
  fee: string;
  /** Exact USDT valuation fixed at commit time (exact decimal string). */
  valuation: string;
  /** Commit timestamp in ms. */
  committedAt: number;
}

export interface TransferRejected {
  status: 'rejected';
  key: string;
  reason: RejectReason;
}

export interface TransferConflict {
  status: 'conflict';
  key: string;
}

export type TransferResult = TransferSuccess | TransferRejected | TransferConflict;

export interface WalletInspection {
  wallet: string;
  /** Balance per token as 8-decimal strings. */
  balances: Record<Token, string>;
  /** Rolling 24h usage as exact USDT decimal string. */
  windowUsed: string;
  /** Remaining rolling allowance as exact USDT decimal string. */
  windowRemaining: string;
}
