import { DatabaseSync } from "node:sqlite";

/** 在建好的连接上创建表结构与索引（幂等）。 */
export function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS classes (
      class_id TEXT PRIMARY KEY,
      capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 30),
      start_min INTEGER NOT NULL,
      end_min INTEGER NOT NULL CHECK (end_min > start_min),
      enrolled_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS applications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL,
      class_id TEXT NOT NULL REFERENCES classes(class_id),
      status TEXT NOT NULL CHECK (status IN ('enrolled', 'waitlisted'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_active
      ON applications (student_id, class_id);
    CREATE INDEX IF NOT EXISTS idx_applications_class
      ON applications (class_id, status, seq);
    CREATE INDEX IF NOT EXISTS idx_applications_student
      ON applications (student_id, status);
    CREATE INDEX IF NOT EXISTS idx_applications_seq
      ON applications (status, seq);
  `);
}
