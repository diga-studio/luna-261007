import { DatabaseSync } from "node:sqlite";
import type { CustodyEvent, EventInput } from "./types.js";

export interface SealInfo {
  totalCount: number;
  root: Buffer;
}

export interface RecordEntry {
  key: Buffer;
  count: number;
  head: Buffer;
}

interface EventRow {
  seq: number | bigint;
  record_id: string;
  ts: number | bigint;
  operator: string;
  body: string;
}

/** 账册持久化层（SQLite，node:sqlite）。 */
export class Storage {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): Storage {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        record_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        operator TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_record ON events(record_id, seq);
      CREATE TABLE IF NOT EXISTS records (
        key BLOB PRIMARY KEY,
        count INTEGER NOT NULL,
        head BLOB NOT NULL
      );
    `);
    return new Storage(db);
  }

  close(): void {
    this.db.close();
  }

  private metaGet(key: string): Buffer | null {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(key) as
      | { v: Uint8Array }
      | undefined;
    return row === undefined ? null : Buffer.from(row.v);
  }

  private metaSet(key: string, value: Uint8Array): void {
    this.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run(key, value);
  }

  isSealed(): boolean {
    return this.metaGet("sealed") !== null;
  }

  /** 追加事件，返回分配的全局序号。 */
  appendEvent(input: EventInput): number {
    const stmt = this.db.prepare(
      "INSERT INTO events (record_id, ts, operator, body) VALUES (?, ?, ?, ?)",
    );
    const info = stmt.run(input.recordId, input.timestamp, input.operator, input.body);
    return Number(info.lastInsertRowid);
  }

  /** 批量追加（单事务），返回首个分配的全局序号。 */
  appendEvents(inputs: EventInput[]): number {
    if (inputs.length === 0) return 0;
    const stmt = this.db.prepare(
      "INSERT INTO events (record_id, ts, operator, body) VALUES (?, ?, ?, ?)",
    );
    let firstSeq = 0;
    this.db.exec("BEGIN");
    try {
      for (const input of inputs) {
        const info = stmt.run(input.recordId, input.timestamp, input.operator, input.body);
        if (firstSeq === 0) firstSeq = Number(info.lastInsertRowid);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return firstSeq;
  }

  /** 按 seq 升序遍历全部事件。 */
  *iterateEvents(): Iterable<CustodyEvent> {
    const it = this.db
      .prepare("SELECT seq, record_id, ts, operator, body FROM events ORDER BY seq")
      .iterate() as Iterable<EventRow>;
    for (const row of it) {
      yield {
        seq: Number(row.seq),
        recordId: row.record_id,
        timestamp: Number(row.ts),
        operator: row.operator,
        body: row.body,
      };
    }
  }

  /** 按 seq 升序取出某记录的全部事件。 */
  eventsOfRecord(recordId: string): CustodyEvent[] {
    const rows = this.db
      .prepare(
        "SELECT seq, record_id, ts, operator, body FROM events WHERE record_id = ? ORDER BY seq",
      )
      .all(recordId) as unknown as EventRow[];
    return rows.map((row) => ({
      seq: Number(row.seq),
      recordId: row.record_id,
      timestamp: Number(row.ts),
      operator: row.operator,
      body: row.body,
    }));
  }

  /** 写入封存结果（目录 + 根 + 总数），并把账册置为只读。 */
  finalizeSeal(records: RecordEntry[], root: Buffer, totalCount: number): void {
    const total = Buffer.alloc(8);
    total.writeBigUInt64BE(BigInt(totalCount));
    this.db.exec("BEGIN");
    try {
      const ins = this.db.prepare("INSERT INTO records (key, count, head) VALUES (?, ?, ?)");
      for (const r of records) ins.run(r.key, r.count, r.head);
      this.metaSet("root", root);
      this.metaSet("totalCount", total);
      this.metaSet("sealed", Buffer.from([1]));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  sealInfo(): SealInfo | null {
    const root = this.metaGet("root");
    const total = this.metaGet("totalCount");
    if (root === null || total === null) return null;
    return { totalCount: Number(total.readBigUInt64BE()), root };
  }

  /** 读取封存时保存的目录（按键升序）。 */
  loadDirectory(): RecordEntry[] {
    const rows = this.db
      .prepare("SELECT key, count, head FROM records")
      .all() as unknown as { key: Uint8Array; count: number | bigint; head: Uint8Array }[];
    const entries = rows.map((row) => ({
      key: Buffer.from(row.key),
      count: Number(row.count),
      head: Buffer.from(row.head),
    }));
    entries.sort((a, b) => Buffer.compare(a.key, b.key));
    return entries;
  }
}
