import { DatabaseSync } from "node:sqlite";
import { ReleaseInfo } from "./types";

interface ReleaseRow {
  publish_id: string;
  manifest_json: string;
  group_id: string;
  artifact_id: string;
  version: string;
  actual_version: string;
  build_number: number;
  committed: number;
}

/** SQLite 元数据层：发布记录与构建号分配。 */
export class MetadataStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        publish_id TEXT PRIMARY KEY,
        manifest_json TEXT NOT NULL,
        group_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version TEXT NOT NULL,
        actual_version TEXT NOT NULL UNIQUE,
        build_number INTEGER NOT NULL,
        committed INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  close(): void {
    this.db.close();
  }

  private static toInfo(row: ReleaseRow): ReleaseInfo {
    return {
      publishId: row.publish_id,
      manifest: JSON.parse(row.manifest_json),
      actualVersion: row.actual_version,
      buildNumber: row.build_number,
      committed: row.committed !== 0,
    };
  }

  getByPublishId(publishId: string): ReleaseInfo | null {
    const row = this.db
      .prepare("SELECT * FROM releases WHERE publish_id = ?")
      .get(publishId) as ReleaseRow | undefined;
    return row ? MetadataStore.toInfo(row) : null;
  }

  /**
   * 分配下一个构建号并插入一条 registered 记录。
   * 构建号 = 该逻辑坐标历史最大号 + 1，已分配的号永不复用。
   */
  insertRegistered(info: ReleaseInfo): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT COALESCE(MAX(build_number), 0) + 1 AS next FROM releases WHERE group_id = ? AND artifact_id = ? AND version = ?"
        )
        .get(info.manifest.groupId, info.manifest.artifactId, info.manifest.version) as { next: number };
      const buildNumber = row.next;
      const actualVersion = `${info.actualVersion}-${buildNumber}`;
      this.db
        .prepare(
          `INSERT INTO releases (publish_id, manifest_json, group_id, artifact_id, version, actual_version, build_number, committed)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
        )
        .run(
          info.publishId,
          JSON.stringify(info.manifest),
          info.manifest.groupId,
          info.manifest.artifactId,
          info.manifest.version,
          actualVersion,
          buildNumber
        );
      this.db.exec("COMMIT");
      info.buildNumber = buildNumber;
      info.actualVersion = actualVersion;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  markCommitted(publishId: string): void {
    this.db.prepare("UPDATE releases SET committed = 1 WHERE publish_id = ?").run(publishId);
  }

  findCurrentSnapshot(groupId: string, artifactId: string, version: string): ReleaseInfo | null {
    const row = this.db
      .prepare(
        `SELECT * FROM releases
         WHERE group_id = ? AND artifact_id = ? AND version = ? AND committed = 1
         ORDER BY build_number DESC LIMIT 1`
      )
      .get(groupId, artifactId, version) as ReleaseRow | undefined;
    return row ? MetadataStore.toInfo(row) : null;
  }

  getByActualVersion(actualVersion: string): ReleaseInfo | null {
    const row = this.db
      .prepare("SELECT * FROM releases WHERE actual_version = ? AND committed = 1")
      .get(actualVersion) as ReleaseRow | undefined;
    return row ? MetadataStore.toInfo(row) : null;
  }

  listUncommitted(): ReleaseInfo[] {
    const rows = this.db
      .prepare("SELECT * FROM releases WHERE committed = 0")
      .all() as unknown as ReleaseRow[];
    return rows.map(MetadataStore.toInfo);
  }
}
