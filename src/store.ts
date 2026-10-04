import { DatabaseSync } from 'node:sqlite';
import type { Manifest } from './types.js';
import { actualVersionOf } from './manifest.js';

export interface ReleaseRow {
  releaseId: string;
  groupId: string;
  artifactId: string;
  version: string;
  timestampUtc: string;
  pomLength: number;
  pomSha256: string;
  jarLength: number;
  jarSha256: string;
  buildNumber: number;
  actualVersion: string;
  committed: boolean;
}

/** SQLite 元数据访问层。 */
export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS coordinates (
        group_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version TEXT NOT NULL,
        next_build INTEGER NOT NULL,
        PRIMARY KEY (group_id, artifact_id, version)
      );
      CREATE TABLE IF NOT EXISTS releases (
        release_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version TEXT NOT NULL,
        timestamp_utc TEXT NOT NULL,
        pom_length INTEGER NOT NULL,
        pom_sha256 TEXT NOT NULL,
        jar_length INTEGER NOT NULL,
        jar_sha256 TEXT NOT NULL,
        build_number INTEGER NOT NULL,
        actual_version TEXT NOT NULL,
        committed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_releases_coord
        ON releases(group_id, artifact_id, version, committed, build_number);
    `);
  }

  close(): void {
    this.db.close();
  }

  findRelease(releaseId: string): ReleaseRow | null {
    const row = this.db
      .prepare('SELECT * FROM releases WHERE release_id = ?')
      .get(releaseId);
    return row ? toReleaseRow(row as Record<string, unknown>) : null;
  }

  /** 在同一事务内分配构建号并插入登记记录。 */
  insertRelease(manifest: Manifest, releaseId: string): ReleaseRow {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const coord = this.db
        .prepare(
          'SELECT next_build FROM coordinates WHERE group_id = ? AND artifact_id = ? AND version = ?',
        )
        .get(manifest.groupId, manifest.artifactId, manifest.version) as
        | { next_build: number }
        | undefined;
      let buildNumber: number;
      if (coord) {
        buildNumber = coord.next_build;
        this.db
          .prepare(
            'UPDATE coordinates SET next_build = ? WHERE group_id = ? AND artifact_id = ? AND version = ?',
          )
          .run(buildNumber + 1, manifest.groupId, manifest.artifactId, manifest.version);
      } else {
        buildNumber = 1;
        this.db
          .prepare(
            'INSERT INTO coordinates (group_id, artifact_id, version, next_build) VALUES (?, ?, ?, 2)',
          )
          .run(manifest.groupId, manifest.artifactId, manifest.version);
      }
      const actualVersion = actualVersionOf(manifest.version, manifest.timestampUtc, buildNumber);
      this.db
        .prepare(
          `INSERT INTO releases (
             release_id, group_id, artifact_id, version, timestamp_utc,
             pom_length, pom_sha256, jar_length, jar_sha256,
             build_number, actual_version, committed
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          releaseId,
          manifest.groupId,
          manifest.artifactId,
          manifest.version,
          manifest.timestampUtc,
          manifest.pom.length,
          manifest.pom.sha256,
          manifest.jar.length,
          manifest.jar.sha256,
          buildNumber,
          actualVersion,
        );
      this.db.exec('COMMIT');
      return {
        releaseId,
        groupId: manifest.groupId,
        artifactId: manifest.artifactId,
        version: manifest.version,
        timestampUtc: manifest.timestampUtc,
        pomLength: manifest.pom.length,
        pomSha256: manifest.pom.sha256,
        jarLength: manifest.jar.length,
        jarSha256: manifest.jar.sha256,
        buildNumber,
        actualVersion,
        committed: false,
      };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  markCommitted(releaseId: string): void {
    this.db.prepare('UPDATE releases SET committed = 1 WHERE release_id = ?').run(releaseId);
  }

  /** 指定逻辑坐标下已完成的发布中构建号最大者。 */
  latestCommitted(groupId: string, artifactId: string, version: string): ReleaseRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM releases
         WHERE group_id = ? AND artifact_id = ? AND version = ? AND committed = 1
         ORDER BY build_number DESC LIMIT 1`,
      )
      .get(groupId, artifactId, version);
    return row ? toReleaseRow(row as Record<string, unknown>) : null;
  }

  findCommittedByActualVersion(
    groupId: string,
    artifactId: string,
    actualVersion: string,
  ): ReleaseRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM releases
         WHERE group_id = ? AND artifact_id = ? AND actual_version = ? AND committed = 1`,
      )
      .get(groupId, artifactId, actualVersion);
    return row ? toReleaseRow(row as Record<string, unknown>) : null;
  }

  /** 所有仍处于“已登记未完成”状态的发布（恢复用）。 */
  pendingReleases(): ReleaseRow[] {
    const rows = this.db
      .prepare('SELECT * FROM releases WHERE committed = 0')
      .all() as Record<string, unknown>[];
    return rows.map(toReleaseRow);
  }
}

function toReleaseRow(row: Record<string, unknown>): ReleaseRow {
  return {
    releaseId: row.release_id as string,
    groupId: row.group_id as string,
    artifactId: row.artifact_id as string,
    version: row.version as string,
    timestampUtc: row.timestamp_utc as string,
    pomLength: Number(row.pom_length),
    pomSha256: row.pom_sha256 as string,
    jarLength: Number(row.jar_length),
    jarSha256: row.jar_sha256 as string,
    buildNumber: Number(row.build_number),
    actualVersion: row.actual_version as string,
    committed: Number(row.committed) === 1,
  };
}
