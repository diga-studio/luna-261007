import { CdxBom, CdxComponent, CdxDependency, InstanceGraph, ResolvedInstance } from "./types";

/** 由安装路径派生稳定的 bom-ref：同一安装位置重复生成时引用不变。 */
export function bomRef(instance: ResolvedInstance): string {
  return instance.path === "" ? "sbom:component:root" : `sbom:component:${instance.path}`;
}

function toComponent(instance: ResolvedInstance, type: "library" | "application"): CdxComponent {
  const component: CdxComponent = {
    "bom-ref": bomRef(instance),
    type,
    name: instance.name,
  };
  if (instance.version !== undefined) component.version = instance.version;
  return component;
}

/** 把实例图转换为 CycloneDX 1.5 JSON BOM。 */
export function toCycloneDx(graph: InstanceGraph): CdxBom {
  const all = [...graph.instances.values()].sort((a, b) =>
    a.path === "" ? -1 : b.path === "" ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  const components: CdxComponent[] = all
    .filter((instance) => instance.path !== "")
    .map((instance) => toComponent(instance, "library"));

  const dependencies: CdxDependency[] = all.map((instance) => ({
    ref: bomRef(instance),
    dependsOn: instance.dependencies.map(bomRef),
  }));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      component: toComponent(graph.root, "application"),
    },
    components,
    dependencies,
  };
}
