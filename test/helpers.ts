/** Independent oracle: V8's RegExp engine with dotall, absolute anchors. */
export function refMatch(pattern: string, body: Uint8Array): boolean {
  const text = String.fromCharCode(...body);
  return new RegExp(pattern, "s").test(text);
}
