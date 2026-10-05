/**
 * 按 LF 分行。LF 属于前一行；末行允许无 LF；
 * 空文本为零行；末尾 LF 不产生额外空行。
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const lf = text.indexOf("\n", start);
    if (lf === -1) {
      break;
    }
    lines.push(text.slice(start, lf + 1));
    start = lf + 1;
  }
  if (start < text.length) {
    lines.push(text.slice(start));
  }
  return lines;
}

/** 把若干行原样拼接回文本。 */
export function joinLines(lines: readonly string[]): string {
  return lines.join("");
}
