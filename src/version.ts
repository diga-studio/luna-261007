const VERSION_PATTERN = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;
const SEGMENT_MAX = 65535;

/**
 * 版本 "major.minor.patch" 编码为单个可直接数值比较的数字：
 * major * 2^32 + minor * 2^16 + patch（每段 0..65535，结果在安全整数范围内）。
 * 编码后的数值大小关系与三段依次数值比较的结果一致。
 */
export function parseVersion(version: string): number {
  const match = VERSION_PATTERN.exec(version);
  if (match === null) {
    throw new Error(`invalid version: ${JSON.stringify(version)}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major > SEGMENT_MAX || minor > SEGMENT_MAX || patch > SEGMENT_MAX) {
    throw new Error(`version segment out of range: ${JSON.stringify(version)}`);
  }
  return major * 2 ** 32 + minor * 2 ** 16 + patch;
}
