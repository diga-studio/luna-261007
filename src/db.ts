import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS timelines (
  ip TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  asset_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timelines_ip_start ON timelines (ip, start_ms);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  src_ip TEXT NOT NULL,
  dst_ip TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  severity_rank INTEGER NOT NULL,
  src_asset_id TEXT,
  dst_asset_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_observations_src_ip ON observations (src_ip);
CREATE INDEX IF NOT EXISTS idx_observations_dst_ip ON observations (dst_ip);
CREATE INDEX IF NOT EXISTS idx_observations_edge ON observations (src_asset_id, dst_asset_id);

CREATE TABLE IF NOT EXISTS edges (
  src_asset_id TEXT NOT NULL,
  dst_asset_id TEXT NOT NULL,
  support_count INTEGER NOT NULL,
  last_observed_at_ms INTEGER NOT NULL,
  severity_rank INTEGER NOT NULL,
  PRIMARY KEY (src_asset_id, dst_asset_id)
);
`;

/** Open (or create) the SQLite database and ensure the schema exists. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}
