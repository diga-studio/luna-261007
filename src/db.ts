import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS timelines (
  ip        TEXT    NOT NULL,
  start_ms  INTEGER NOT NULL,
  end_ms    INTEGER,              -- NULL means open-ended
  asset_id  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timelines_ip_start ON timelines(ip, start_ms);

CREATE TABLE IF NOT EXISTS observations (
  id        TEXT    PRIMARY KEY,
  src_ip    TEXT    NOT NULL,
  dst_ip    TEXT    NOT NULL,
  ts        INTEGER NOT NULL,
  severity  TEXT    NOT NULL,
  src_asset TEXT,                 -- owner of src_ip at ts; NULL = gap
  dst_asset TEXT                  -- owner of dst_ip at ts; NULL = gap
);
CREATE INDEX IF NOT EXISTS idx_obs_src_ip ON observations(src_ip);
CREATE INDEX IF NOT EXISTS idx_obs_dst_ip ON observations(dst_ip);
CREATE INDEX IF NOT EXISTS idx_obs_edge ON observations(src_asset, dst_asset);

CREATE TABLE IF NOT EXISTS edges (
  src_asset TEXT    NOT NULL,
  dst_asset TEXT    NOT NULL,
  cnt       INTEGER NOT NULL,
  last_ts   INTEGER NOT NULL,
  sev_rank  INTEGER NOT NULL,
  PRIMARY KEY (src_asset, dst_asset)
);
`;

/** Open (or create) the database and ensure the schema exists. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}
