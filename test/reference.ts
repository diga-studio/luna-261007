/**
 * Independent reference implementation used only by tests.
 *
 * The library's pattern syntax is a deliberate subset of JavaScript RegExp:
 *   - bytes 0..255 map to latin1 code points 0..255,
 *   - '.' with the 's' flag matches any byte including newline,
 *   - '^' / '$' without the 'm' flag are absolute input anchors,
 *   - negated classes over a latin1 string negate over all 256 bytes.
 * V8's Irregexp engine is therefore a genuinely independent oracle.
 */
export function referenceMatches(pattern: string, body: Uint8Array): boolean {
  const re = new RegExp(pattern, 's');
  let text = '';
  for (const byte of body) text += String.fromCharCode(byte);
  return re.test(text);
}

/** Reference hit set for a list of rules against a whole body. */
export function referenceHitSet(
  rules: ReadonlyArray<{ id: string; pattern: string }>,
  body: Uint8Array,
): Set<string> {
  const hits = new Set<string>();
  for (const rule of rules) {
    if (referenceMatches(rule.pattern, body)) hits.add(rule.id);
  }
  return hits;
}
