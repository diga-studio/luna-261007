import { DatabaseSync } from 'node:sqlite';
import type { CommandResult } from './types.js';

export interface QuarantineRecord {
  quarantineId: string;
  relativePath: string;
  sha256: string;
  state: 'held' | 'restored';
}

interface CommandRow {
  command_id: string;
  op: string;
  params: string;
  result: string;
}

interface QuarantineRow {
  quarantine_id: string;
  relative_path: string;
  sha256: string;
  state: string;
}

export class MetadataStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        op TEXT NOT NULL,
        params TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quarantines (
        quarantine_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('held', 'restored')),
        created_at TEXT NOT NULL,
        restored_at TEXT
      );
    `);
  }

  getCommand(commandId: string): CommandResult | null {
    const row = this.db
      .prepare('SELECT result FROM commands WHERE command_id = ?')
      .get(commandId) as Pick<CommandRow, 'result'> | undefined;
    if (!row) return null;
    return JSON.parse(row.result) as CommandResult;
  }

  getCommandParams(commandId: string): string | null {
    const row = this.db
      .prepare('SELECT params FROM commands WHERE command_id = ?')
      .get(commandId) as Pick<CommandRow, 'params'> | undefined;
    return row ? row.params : null;
  }

  recordCommand(commandId: string, op: string, paramsJson: string, result: CommandResult): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO commands (command_id, op, params, result, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(commandId, op, paramsJson, JSON.stringify(result), new Date().toISOString());
  }

  insertQuarantine(record: QuarantineRecord): void {
    this.db
      .prepare(
        'INSERT INTO quarantines (quarantine_id, relative_path, sha256, state, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        record.quarantineId,
        record.relativePath,
        record.sha256,
        record.state,
        new Date().toISOString(),
      );
  }

  getQuarantine(quarantineId: string): QuarantineRecord | null {
    const row = this.db
      .prepare('SELECT quarantine_id, relative_path, sha256, state FROM quarantines WHERE quarantine_id = ?')
      .get(quarantineId) as QuarantineRow | undefined;
    if (!row) return null;
    return {
      quarantineId: row.quarantine_id,
      relativePath: row.relative_path,
      sha256: row.sha256,
      state: row.state === 'held' ? 'held' : 'restored',
    };
  }

  markRestored(quarantineId: string): void {
    this.db
      .prepare("UPDATE quarantines SET state = 'restored', restored_at = ? WHERE quarantine_id = ?")
      .run(new Date().toISOString(), quarantineId);
  }

  close(): void {
    this.db.close();
  }
}
