/**
 * Splits text into lines on LF. The LF belongs to the line it terminates.
 * The last line may lack a trailing LF. Empty text yields zero lines;
 * a trailing LF does not produce an extra empty line.
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
