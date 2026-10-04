export const HOURS_PER_DAY = 24;
export const HOT_DAYS = 30;
export const RETENTION_DAYS = 90;
export const HOT_HOURS = HOT_DAYS * HOURS_PER_DAY;
export const RETENTION_HOURS = RETENTION_DAYS * HOURS_PER_DAY;
/** Cold archives are chunked per UTC day. */
export const ARCHIVE_CHUNK_HOURS = HOURS_PER_DAY;
