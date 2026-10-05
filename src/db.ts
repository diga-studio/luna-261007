import * as fs from 'node:fs';
import * as path from 'node:path';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { TERMINAL_STATUSES, type PipelineDefinition, type RunRecord, type RunStatus } from './types';

let sqlPromise: Promise<SqlJsStatic> | null = null;

function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    // wasm 与 sql.js 主文件同目录，用 require.resolve 定位，避免依赖安装布局。
    const sqlJsDir = path.dirname(require.resolve('sql.js'));
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(sqlJsDir, file),
    });
  }
  return sqlPromise;
}

/** SQLite 持久化：运行记录。单进程内同步读写，写后落盘。 */
export class RunStore {
  private db: Database | null = null;

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    const SQL = await loadSqlJs();
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    if (fs.existsSync(this.dbPath)) {
      this.db = new SQL.Database(fs.readFileSync(this.dbPath));
    } else {
      this.db = new SQL.Database();
    }
    this.db.run(
      `CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        definition TEXT NOT NULL,
        reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    this.persist();
  }

  insert(id: string, definition: PipelineDefinition, now: number): void {
    this.handle().run(
      'INSERT INTO runs (id, status, definition, reason, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
      [id, 'Queued', JSON.stringify(definition), now, now],
    );
    this.persist();
  }

  /** 仅当当前状态满足 expected 时才更新，返回是否更新成功。终态不可变。 */
  transition(id: string, expected: RunStatus[] | 'any-non-terminal', next: RunStatus, reason: string | null, now: number): boolean {
    const current = this.get(id);
    if (!current) return false;
    if (TERMINAL_STATUSES.has(current.status)) return false;
    const allowed = expected === 'any-non-terminal' ? !TERMINAL_STATUSES.has(current.status) : expected.includes(current.status);
    if (!allowed) return false;
    this.handle().run('UPDATE runs SET status = ?, reason = ?, updated_at = ? WHERE id = ?', [next, reason, now, id]);
    this.persist();
    return true;
  }

  /** 进程重启恢复：把遗留的非终态运行标记为 Failed。 */
  failNonTerminal(reason: string, now: number): void {
    this.handle().run("UPDATE runs SET status = 'Failed', reason = ?, updated_at = ? WHERE status IN ('Queued', 'Running')", [reason, now]);
    this.persist();
  }

  get(id: string): RunRecord | null {
    const stmt = this.handle().prepare('SELECT id, status, definition, reason, created_at, updated_at FROM runs WHERE id = ?');
    try {
      stmt.bind([id]);
      if (!stmt.step()) return null;
      const row = stmt.getAsObject() as Record<string, unknown>;
      return {
        id: row.id as string,
        status: row.status as RunStatus,
        definition: JSON.parse(row.definition as string) as PipelineDefinition,
        reason: (row.reason as string | null) ?? null,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
    } finally {
      stmt.free();
    }
  }

  close(): void {
    if (this.db) {
      this.persist();
      this.db.close();
      this.db = null;
    }
  }

  private handle(): Database {
    if (!this.db) throw new Error('RunStore not initialized');
    return this.db;
  }

  /** 原子落盘：先写临时文件再 rename。 */
  private persist(): void {
    if (!this.db) return;
    const data = this.db.export();
    const tmp = `${this.dbPath}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.dbPath);
  }
}
