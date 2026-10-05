import { CycloneDxBom, CycloneDxComponent, CycloneDxDependency, PackageInstance } from "./types";

/** 由安装路径生成稳定的 bom-ref（同一安装位置重复生成时引用不变）。 */
function bomRef(instance: PackageInstance): string {
  return `pkg:${instance.id === "" ? "." : instance.id}`;
}

/** 把实例图转换为 CycloneDX 1.5 JSON SBOM。 */
export function buildSbom(root: PackageInstance, instances: PackageInstance[]): CycloneDxBom {
  const refs = new Map<PackageInstance, string>();
  for (const inst of instances) {
    refs.set(inst, bomRef(inst));
  }

  const toComponent = (inst: PackageInstance): CycloneDxComponent => ({
    type: inst === root ? "application" : "library",
    "bom-ref": refs.get(inst)!,
    name: inst.name,
    version: inst.version,
  });

  const components = instances.filter((i) => i !== root).map(toComponent);

  const dependencies: CycloneDxDependency[] = instances.map((inst) => ({
    ref: refs.get(inst)!,
    dependsOn: inst.dependencies.map((d) => {
      const ref = refs.get(d);
      if (ref === undefined) {
        throw new Error(`实例 "${inst.id}" 的依赖 "${d.id}" 不在实例集合中`);
      }
      return ref;
    }),
  }));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: { component: toComponent(root) },
    components,
    dependencies,
  };
}
