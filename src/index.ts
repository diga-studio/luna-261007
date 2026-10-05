import { resolveInstances } from "./resolve";
import { toCycloneDx } from "./sbom";
import { CdxBom, PackageLock } from "./types";

export * from "./types";
export { resolveInstances } from "./resolve";
export { toCycloneDx } from "./sbom";

/** 从 package-lock.json 内容（对象或 JSON 字符串）生成 CycloneDX 1.5 SBOM。 */
export function generateSbom(lock: PackageLock | string): CdxBom {
  const parsed: PackageLock = typeof lock === "string" ? JSON.parse(lock) : lock;
  return toCycloneDx(resolveInstances(parsed));
}
