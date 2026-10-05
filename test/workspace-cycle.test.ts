import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSbom, PackageLock } from "../src/index";
import { summarize } from "./helpers";

// 工作区链接 + peer 闭环。
// 独立预期：
// - node_modules/foo 与 node_modules/foo-alias 都是指向 packages/foo 的链接，合并为同一实例。
// - packages/foo 与 packages/bar 通过 peerDependencies 互相引用，闭环必须保留。
// - bar 的 peer "foo" 从 packages/bar 的真实目录向上解析到根层链接，再回到 packages/foo。
const lock: PackageLock = {
  name: "mono",
  version: "0.0.0",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "mono",
      version: "0.0.0",
      dependencies: { foo: "*", "foo-alias": "*", bar: "*" },
    },
    "node_modules/foo": { resolved: "packages/foo", link: true },
    "node_modules/foo-alias": { resolved: "packages/foo", link: true },
    "node_modules/bar": { resolved: "packages/bar", link: true },
    "packages/foo": {
      name: "@mono/foo",
      version: "1.0.0",
      peerDependencies: { bar: "1.x" },
    },
    "packages/bar": {
      name: "@mono/bar",
      version: "1.1.0",
      peerDependencies: { foo: "1.x" },
    },
  },
};

test("工作区链接与peer闭环：身份合并及闭环保留", () => {
  const bom = generateSbom(lock);

  assert.deepStrictEqual(summarize(bom), {
    metadata: { ref: "sbom:component:root", type: "application", name: "mono", version: "0.0.0" },
    components: [
      { ref: "sbom:component:packages/bar", name: "@mono/bar", version: "1.1.0" },
      { ref: "sbom:component:packages/foo", name: "@mono/foo", version: "1.0.0" },
    ],
    deps: [
      { ref: "sbom:component:packages/bar", dependsOn: ["sbom:component:packages/foo"] },
      { ref: "sbom:component:packages/foo", dependsOn: ["sbom:component:packages/bar"] },
      {
        ref: "sbom:component:root",
        dependsOn: ["sbom:component:packages/bar", "sbom:component:packages/foo"],
      },
    ],
  });

  // 链接自身不产生组件；所有依赖引用都存在于组件或根中。
  const knownRefs = new Set([
    bom.metadata.component["bom-ref"],
    ...bom.components.map((c) => c["bom-ref"]),
  ]);
  for (const dep of bom.dependencies) {
    assert.ok(knownRefs.has(dep.ref), `unknown ref ${dep.ref}`);
    for (const target of dep.dependsOn) {
      assert.ok(knownRefs.has(target), `unknown dependsOn ${target}`);
    }
  }
});
