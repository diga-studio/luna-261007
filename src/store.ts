import { DatabaseSync } from "node:sqlite";
import type { WordEntry } from "./types.js";

/** SQLite 词表存储：全量替换 + 读取，重新打开库后仍可用 */
export class WordStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS word_entries (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL
      )
    `);
  }

  replaceAll(entries: WordEntry[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM word_entries");
      const insert = this.db.prepare("INSERT INTO word_entries (id, text) VALUES (?, ?)");
      for (const entry of entries) {
        insert.run(entry.id, entry.text);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getAll(): WordEntry[] {
    const rows = this.db
      .prepare("SELECT id, text FROM word_entries ORDER BY id")
      .all() as unknown as { id: number; text: string }[];
    return rows.map((row) => ({ id: row.id, text: row.text }));
  }

  close(): void {
    this.db.close();
  }
}
