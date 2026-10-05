import { resolveInstances } from "./resolve";
import { buildSbom } from "./sbom";
import { CycloneDxBom, PackageLock } from "./types";

export * from "./types";
export { resolveInstances } from "./resolve";
export { buildSbom } from "./sbom";

/** 从 package-lock 对象生成 CycloneDX 1.5 SBOM。 */
export function generateSbomFromLock(lock: PackageLock): CycloneDxBom {
  const instances = resolveInstances(lock);
  return buildSbom(instances[0], instances);
}

/** 从 package-lock.json 文本生成 CycloneDX 1.5 SBOM。 */
export function generateSbom(lockfileJson: string): CycloneDxBom {
  return generateSbomFromLock(JSON.parse(lockfileJson) as PackageLock);
}
