import type { Manifest } from './types.js';
import { InvalidManifestError } from './errors.js';

const TIMESTAMP_RE = /^\d{8}\.\d{6}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

/** 校验清单，不合法时抛出 InvalidManifestError。 */
export function validateManifest(manifest: Manifest): void {
  if (typeof manifest !== 'object' || manifest === null) {
    throw new InvalidManifestError('manifest must be an object');
  }
  const { groupId, artifactId, version, timestampUtc, pom, jar } = manifest;
  if (!groupId || !artifactId) {
    throw new InvalidManifestError('groupId and artifactId must be non-empty');
  }
  if (typeof version !== 'string' || !version.endsWith('-SNAPSHOT') || version.length <= '-SNAPSHOT'.length) {
    throw new InvalidManifestError(`version must end with -SNAPSHOT: ${version}`);
  }
  if (typeof timestampUtc !== 'string' || !TIMESTAMP_RE.test(timestampUtc)) {
    throw new InvalidManifestError(`timestampUtc must be yyyyMMdd.HHmmss: ${timestampUtc}`);
  }
  for (const [kind, spec] of [['pom', pom], ['jar', jar]] as const) {
    if (typeof spec !== 'object' || spec === null) {
      throw new InvalidManifestError(`${kind} file spec missing`);
    }
    if (!Number.isSafeInteger(spec.length) || spec.length < 0) {
      throw new InvalidManifestError(`${kind}.length must be a non-negative integer`);
    }
    if (typeof spec.sha256 !== 'string' || !SHA256_RE.test(spec.sha256)) {
      throw new InvalidManifestError(`${kind}.sha256 must be 64 lowercase hex chars`);
    }
  }
}

/** 由逻辑版本、UTC 时间戳与构建号计算实际版本。 */
export function actualVersionOf(version: string, timestampUtc: string, buildNumber: number): string {
  const base = version.slice(0, version.length - 'SNAPSHOT'.length);
  return `${base}${timestampUtc}-${buildNumber}`;
}

/** 同标识重复登记时的逐字段比对。 */
export function manifestEquals(a: Manifest, b: Manifest): boolean {
  return (
    a.groupId === b.groupId &&
    a.artifactId === b.artifactId &&
    a.version === b.version &&
    a.timestampUtc === b.timestampUtc &&
    a.pom.length === b.pom.length &&
    a.pom.sha256 === b.pom.sha256 &&
    a.jar.length === b.jar.length &&
    a.jar.sha256 === b.jar.sha256
  );
}
