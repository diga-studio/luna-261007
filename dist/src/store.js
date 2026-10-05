"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WordStore = void 0;
const node_sqlite_1 = require("node:sqlite");
/** SQLite 词表存储：全量替换 + 读取，重新打开库后仍可用 */
class WordStore {
    db;
    constructor(dbPath) {
        this.db = new node_sqlite_1.DatabaseSync(dbPath);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS word_entries (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL
      )
    `);
    }
    replaceAll(entries) {
        this.db.exec("BEGIN");
        try {
            this.db.exec("DELETE FROM word_entries");
            const insert = this.db.prepare("INSERT INTO word_entries (id, text) VALUES (?, ?)");
            for (const entry of entries) {
                insert.run(entry.id, entry.text);
            }
            this.db.exec("COMMIT");
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    getAll() {
        const rows = this.db
            .prepare("SELECT id, text FROM word_entries ORDER BY id")
            .all();
        return rows.map((row) => ({ id: row.id, text: row.text }));
    }
    close() {
        this.db.close();
    }
}
exports.WordStore = WordStore;
