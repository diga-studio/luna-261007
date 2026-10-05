import { DatabaseSync } from "node:sqlite";
import type { UploadDeclaration } from "./types.js";
import { DeclarationConflictError } from "./errors.js";

export interface UploadRow {
  uploadId: string;
  totalSize: number;
  sha256: string;
  status: "receiving" | "complete";
  finalPath: string | null;
}

interface UploadRawRow {
  upload_id: string;
  total_size: number;
  sha256: string;
  status: string;
  final_path: string | null;
}

function toUploadRow(row: UploadRawRow): UploadRow {
  return {
    uploadId: row.upload_id,
    totalSize: row.total_size,
    sha256: row.sha256,
    status: row.status === "complete" ? "complete" : "receiving",
    finalPath: row.final_path,
  };
}

/** SQLite 元数据层：上传声明、已确认分块、完成状态。 */
export class MetadataDb {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS uploads (
        upload_id TEXT PRIMARY KEY,
        total_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'receiving',
        final_path TEXT
      );
      CREATE TABLE IF NOT EXISTS chunks (
        upload_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (upload_id, seq)
      );
    `);
  }

  /** 登记上传；同标识同声明幂等，同标识不同声明抛 DeclarationConflictError。 */
  registerUpload(decl: UploadDeclaration): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO uploads (upload_id, total_size, sha256) VALUES (?, ?, ?)",
      )
      .run(decl.uploadId, decl.totalSize, decl.sha256);
    const row = this.getUpload(decl.uploadId);
    if (
      row === null ||
      row.totalSize !== decl.totalSize ||
      row.sha256 !== decl.sha256
    ) {
      throw new DeclarationConflictError(decl.uploadId);
    }
  }

  getUpload(uploadId: string): UploadRow | null {
    const row = this.db
      .prepare(
        "SELECT upload_id, total_size, sha256, status, final_path FROM uploads WHERE upload_id = ?",
      )
      .get(uploadId) as UploadRawRow | undefined;
    return row === undefined ? null : toUploadRow(row);
  }

  listUploads(): UploadRow[] {
    const rows = this.db
      .prepare(
        "SELECT upload_id, total_size, sha256, status, final_path FROM uploads",
      )
      .all() as unknown as UploadRawRow[];
    return rows.map(toUploadRow);
  }

  /** 记录一个已确认分块（已持久化到磁盘后调用）。 */
  addChunk(uploadId: string, seq: number, size: number): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO chunks (upload_id, seq, size) VALUES (?, ?, ?)",
      )
      .run(uploadId, seq, size);
  }

  hasChunk(uploadId: string, seq: number): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS x FROM chunks WHERE upload_id = ? AND seq = ?",
      )
      .get(uploadId, seq);
    return row !== undefined;
  }

  /** 已确认分块，升序序号与各自长度。 */
  listChunks(uploadId: string): { seq: number; size: number }[] {
    return this.db
      .prepare(
        "SELECT seq, size FROM chunks WHERE upload_id = ? ORDER BY seq ASC",
      )
      .all(uploadId) as unknown as { seq: number; size: number }[];
  }

  markComplete(uploadId: string, finalPath: string): void {
    this.db
      .prepare(
        "UPDATE uploads SET status = 'complete', final_path = ? WHERE upload_id = ?",
      )
      .run(finalPath, uploadId);
  }

  close(): void {
    this.db.close();
  }
}
