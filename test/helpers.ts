import { CdxBom } from "../src/index";

export interface BomSummary {
  metadata: { ref: string; type: string; name: string; version?: string };
  components: Array<{ ref: string; name: string; version?: string }>;
  deps: Array<{ ref: string; dependsOn: string[] }>;
}

/** 把 BOM 归一化为可整体 deepStrictEqual 比较的纯数据。 */
export function summarize(bom: CdxBom): BomSummary {
  const components = bom.components
    .map((c) => {
      const out: { ref: string; name: string; version?: string } = {
        ref: c["bom-ref"],
        name: c.name,
      };
      if (c.version !== undefined) out.version = c.version;
      return out;
    })
    .sort((x, y) => (x.ref < y.ref ? -1 : 1));
  const deps = bom.dependencies
    .map((d) => ({ ref: d.ref, dependsOn: [...d.dependsOn].sort() }))
    .sort((x, y) => (x.ref < y.ref ? -1 : 1));
  const metadata: BomSummary["metadata"] = {
    ref: bom.metadata.component["bom-ref"],
    type: bom.metadata.component.type,
    name: bom.metadata.component.name,
  };
  if (bom.metadata.component.version !== undefined) {
    metadata.version = bom.metadata.component.version;
  }
  return { metadata, components, deps };
}
