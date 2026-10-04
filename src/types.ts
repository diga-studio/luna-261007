/** Result of a quarantine command. */
export type QuarantineResult =
  | { status: 'quarantined'; quarantineId: string }
  | { status: 'not_found' }
  | { status: 'sha256_mismatch' };

/** Result of a restore command. */
export type RestoreResult =
  | { status: 'restored' }
  | { status: 'conflict' }
  | { status: 'quarantine_not_found' }
  | { status: 'already_restored' };

export type CommandResult =
  | { op: 'quarantine'; result: QuarantineResult }
  | { op: 'restore'; result: RestoreResult };

export interface ExecutorOptions {
  /** Directory holding the original files. */
  originalRoot: string;
  /** Isolated directory holding quarantined content. */
  quarantineRoot: string;
  /** Path of the SQLite metadata database file. */
  databasePath: string;
}
