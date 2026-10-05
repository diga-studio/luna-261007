import { DatabaseSync } from "node:sqlite";
import { buildNormalizedText, normalizeWord } from "./normalize.js";
import { findHits } from "./match.js";
import type { MatchHit, WordEntry } from "./types.js";

/**
 * 敏感词审核库。词表存 SQLite，可全量替换；
 * 重新打开同一数据库文件后词表仍然可用。
 */
export class SensitiveWordStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS words (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL
      )
    `);
  }

  /** 全量替换词表（事务保证原子性） */
  replaceWords(entries: WordEntry[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM words");
      const insert = this.db.prepare("INSERT INTO words (id, text) VALUES (?, ?)");
      for (const entry of entries) {
        insert.run(entry.id, entry.text);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 检查一条评价，返回全部命中：
   * 含相互重叠的命中；不同编号的词条即使标准化后相同也分别报告。
   * 结果按原文区间起点、终点、词条编号排序。
   */
  check(reviewText: string): MatchHit[] {
    const target = buildNormalizedText(reviewText);
    const rows = this.db
      .prepare("SELECT id, text FROM words ORDER BY id")
      .all() as unknown as WordEntry[];

    const hits: MatchHit[] = [];
    for (const row of rows) {
      hits.push(...findHits(row.id, normalizeWord(row.text), target));
    }
    hits.sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
    return hits;
  }

  close(): void {
    this.db.close();
  }
}
