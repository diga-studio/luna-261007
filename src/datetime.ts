const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?([Zz]|[+-]\d{2}:\d{2})$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/**
 * 解析带 UTC 标记或数值偏移的 RFC3339 时间戳（小数秒 0-3 位），
 * 归一化为 UTC、固定 3 位小数秒的字符串；非法返回 null。
 * 拒绝非法日历日期、闰秒（second=60）与缺失时区的时间，不受机器时区影响。
 */
export function normalizeDateTime(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const match = RFC3339_RE.exec(input);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const frac = match[7] === undefined ? "" : match[7].slice(1);
  const zone = match[8] as string;

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  const millis = Number(frac.padEnd(3, "0") || "0");

  let offsetMinutes = 0;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const offHour = Number(zone.slice(1, 3));
    const offMinute = Number(zone.slice(4, 6));
    if (offHour > 23 || offMinute > 59) return null;
    offsetMinutes = sign * (offHour * 60 + offMinute);
  }

  // Date.UTC 与机器时区无关；0-99 年会被映射到 19xx，需要修正。
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const candidate = new Date(ms);
  if (year >= 0 && year < 100) candidate.setUTCFullYear(year);
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null; // 非法日历日期（如 2 月 30 日）发生进位
  }

  const utc = new Date(candidate.getTime() - offsetMinutes * 60_000);
  const yyyy = utc.getUTCFullYear();
  if (yyyy < 0 || yyyy > 9999) return null;
  return (
    `${pad(yyyy, 4)}-${pad(utc.getUTCMonth() + 1, 2)}-${pad(utc.getUTCDate(), 2)}` +
    `T${pad(utc.getUTCHours(), 2)}:${pad(utc.getUTCMinutes(), 2)}:${pad(utc.getUTCSeconds(), 2)}` +
    `.${pad(utc.getUTCMilliseconds(), 3)}Z`
  );
}
