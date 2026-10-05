import { DatabaseSync } from 'node:sqlite';

export interface UploadRow {
  upload_id: string;
  total_size: number;
  sha256: string;
  chunk_count: number;
  state: string;
  artifact_path: string | null;
}

export interface ChunkRow {
  upload_id: string;
  chunk_index: number;
  sha256: string;
  size: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS uploads (
  upload_id TEXT PRIMARY KEY,
  total_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'uploading',
  artifact_path TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
  upload_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
);
`;

export class MetaDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = FULL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  getUpload(uploadId: string): UploadRow | undefined {
    const row = this.db
      .prepare(
        'SELECT upload_id, total_size, sha256, chunk_count, state, artifact_path FROM uploads WHERE upload_id = ?',
      )
      .get(uploadId);
    return row as UploadRow | undefined;
  }

  insertUpload(row: UploadRow): void {
    this.db
      .prepare(
        'INSERT INTO uploads (upload_id, total_size, sha256, chunk_count, state, artifact_path) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.upload_id,
        row.total_size,
        row.sha256,
        row.chunk_count,
        row.state,
        row.artifact_path,
      );
  }

  markCompleted(uploadId: string, artifactPath: string): void {
    this.db
      .prepare(
        "UPDATE uploads SET state = 'completed', artifact_path = ? WHERE upload_id = ?",
      )
      .run(artifactPath, uploadId);
  }

  getChunk(uploadId: string, chunkIndex: number): ChunkRow | undefined {
    const row = this.db
      .prepare(
        'SELECT upload_id, chunk_index, sha256, size FROM chunks WHERE upload_id = ? AND chunk_index = ?',
      )
      .get(uploadId, chunkIndex);
    return row as ChunkRow | undefined;
  }

  insertChunk(row: ChunkRow): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO chunks (upload_id, chunk_index, sha256, size) VALUES (?, ?, ?, ?)',
      )
      .run(row.upload_id, row.chunk_index, row.sha256, row.size);
  }

  listChunks(uploadId: string): ChunkRow[] {
    const rows = this.db
      .prepare(
        'SELECT upload_id, chunk_index, sha256, size FROM chunks WHERE upload_id = ? ORDER BY chunk_index ASC',
      )
      .all(uploadId);
    return rows as unknown as ChunkRow[];
  }

  listUploads(): UploadRow[] {
    const rows = this.db
      .prepare(
        'SELECT upload_id, total_size, sha256, chunk_count, state, artifact_path FROM uploads',
      )
      .all();
    return rows as unknown as UploadRow[];
  }

  close(): void {
    this.db.close();
  }
}
