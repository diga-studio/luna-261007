/**
 * 版本 "major.minor.patch"（每段 0-65535）编码为单个安全整数：
 * major * 2^32 + minor * 2^16 + patch，数值序即版本序。
 */
export type VersionCode = number;

export const MIN_VERSION_CODE: VersionCode = 0;
export const MAX_VERSION_CODE: VersionCode = 0xffffffffffff;

const VERSION_PATTERN = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;

export function parseVersion(text: string): VersionCode {
  const match = VERSION_PATTERN.exec(text);
  if (match === null) {
    throw new Error(`invalid version: ${JSON.stringify(text)}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > 65535 || minor > 65535 || patch > 65535) {
    throw new Error(`version segment out of range 0-65535: ${JSON.stringify(text)}`);
  }
  return major * 0x100000000 + minor * 0x10000 + patch;
}

export function formatVersion(code: VersionCode): string {
  if (!Number.isSafeInteger(code) || code < MIN_VERSION_CODE || code > MAX_VERSION_CODE) {
    throw new Error(`invalid version code: ${code}`);
  }
  const patch = code % 0x10000;
  const minor = Math.floor(code / 0x10000) % 0x10000;
  const major = Math.floor(code / 0x100000000);
  return `${major}.${minor}.${patch}`;
}
