export function validateEntryPath(name: string): boolean {
  if (name.length === 0) return false;
  const isDir = name.endsWith("/");
  const body = isDir ? name.slice(0, -1) : name;
  if (body.length === 0) return false;
  if (body.includes("\\")) return false;
  if (body.startsWith("/")) return false;
  for (const segment of body.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return false;
  }
  return true;
}

function percentDecodeOnce(target: string): string | null {
  const bytes: number[] = [];
  for (let i = 0; i < target.length; i++) {
    const ch = target[i]!;
    if (ch === "%") {
      if (i + 2 > target.length - 1) return null;
      const hex = target.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      const cp = ch.codePointAt(0)!;
      if (cp < 0x80) {
        bytes.push(cp);
      } else if (cp < 0x800) {
        bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
      }
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

export function resolveRelationshipTarget(
  sourcePartDir: string,
  target: string,
): string | null {
  if (target.length === 0) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;
  if (target.includes("\\") || target.includes("#")) return null;
  const decoded = percentDecodeOnce(target);
  if (decoded === null) return null;
  if (decoded.includes("\\")) return null;

  const absolute = decoded.startsWith("/");
  const combined = absolute
    ? decoded.slice(1)
    : sourcePartDir === ""
      ? decoded
      : `${sourcePartDir}/${decoded}`;

  const segments: string[] = [];
  for (const segment of combined.split("/")) {
    if (segment === "") return null;
    if (segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return null;
  return segments.join("/");
}
