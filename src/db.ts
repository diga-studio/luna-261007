import { DatabaseSync } from "node:sqlite";
import type { CommandRecord, QuarantineEntry } from "./types.js";

interface CommandRow {
  command_id: string;
  op: string;
  result_json: string;
}

interface EntryRow {
  quarantine_id: string;
  relative_path: string;
  sha256: string;
  status: string;
}

/** SQLite 元数据存储：命令记录（幂等）+ 隔离条目 */
export class MetadataStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        op TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quarantine_entries (
        quarantine_id TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('quarantined', 'restored'))
      );
    `);
  }

  findCommand(commandId: string): CommandRecord | undefined {
    const row = this.db
      .prepare("SELECT command_id, op, result_json FROM commands WHERE command_id = ?")
      .get(commandId) as CommandRow | undefined;
    if (!row) return undefined;
    return { commandId: row.command_id, op: row.op as CommandRecord["op"], resultJson: row.result_json };
  }

  recordCommand(commandId: string, op: CommandRecord["op"], result: unknown): void {
    this.db
      .prepare("INSERT INTO commands (command_id, op, result_json) VALUES (?, ?, ?)")
      .run(commandId, op, JSON.stringify(result));
  }

  createEntry(entry: QuarantineEntry): void {
    this.db
      .prepare(
        "INSERT INTO quarantine_entries (quarantine_id, relative_path, sha256, status) VALUES (?, ?, ?, ?)"
      )
      .run(entry.quarantineId, entry.relativePath, entry.sha256, entry.status);
  }

  findEntry(quarantineId: string): QuarantineEntry | undefined {
    const row = this.db
      .prepare(
        "SELECT quarantine_id, relative_path, sha256, status FROM quarantine_entries WHERE quarantine_id = ?"
      )
      .get(quarantineId) as EntryRow | undefined;
    if (!row) return undefined;
    return {
      quarantineId: row.quarantine_id,
      relativePath: row.relative_path,
      sha256: row.sha256,
      status: row.status as QuarantineEntry["status"],
    };
  }

  markRestored(quarantineId: string): void {
    this.db
      .prepare("UPDATE quarantine_entries SET status = 'restored' WHERE quarantine_id = ?")
      .run(quarantineId);
  }

  close(): void {
    this.db.close();
  }
}
