import { DatabaseSync } from 'node:sqlite';

const LAST_SEEN_KEY = 'last_seen_time';

export function checkAndAdvanceClock(db: DatabaseSync, now: number): void {
  if (!Number.isInteger(now) || now < 0) {
    throw new RangeError('now must be a non-negative integer (UTC milliseconds)');
  }
  const row = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(LAST_SEEN_KEY) as { value: string } | undefined;
  if (row !== undefined && now < Number(row.value)) {
    throw new RangeError(
      `now (${now}) must not go backwards; last seen time is ${row.value}`,
    );
  }
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(LAST_SEEN_KEY, String(now));
}
