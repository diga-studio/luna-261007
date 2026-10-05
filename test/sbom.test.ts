import { test } from "node:test";
import { deepEqual, equal, ok } from "node:assert/strict";
import { generateSbom, generateSbomFromLock } from "../src/index";
import { PackageLock } from "../src/types";

const lock: PackageLock = {
  name: "root-app",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "root-app",
      version: "1.0.0",
      dependencies: { a: "^1.0.0", "w-x": "1.0.0" },
    },
    "node_modules/a": {
      name: "a",
      version: "1.0.0",
      dependencies: { b: "^1.0.0" },
    },
    "node_modules/a/node_modules/b": { name: "b", version: "1.0.0" },
    "node_modules/w-x": { resolved: "packages/w-x", link: true },
    "packages/w-x": {
      name: "w-x",
      version: "2.0.0",
      peerDependencies: { a: "^1.0.0" },
    },
  },
};

test("SBOM 符合 CycloneDX 1.5 基本结构", () => {
  const bom = generateSbomFromLock(lock);
  equal(bom.bomFormat, "CycloneDX");
  equal(bom.specVersion, "1.5");
  equal(bom.version, 1);
  deepEqual(bom.metadata.component, {
    type: "application",
    "bom-ref": "pkg:.",
    name: "root-app",
    version: "1.0.0",
  });
});

test("组件与安装实例一一对应，依赖引用全部存在", () => {
  const bom = generateSbomFromLock(lock);
  const componentRefs = new Set(bom.components.map((c) => c["bom-ref"]));
  deepEqual(
    bom.components.map((c) => ({ ref: c["bom-ref"], name: c.name, version: c.version })),
    [
      { ref: "pkg:node_modules/a", name: "a", version: "1.0.0" },
      { ref: "pkg:node_modules/a/node_modules/b", name: "b", version: "1.0.0" },
      { ref: "pkg:packages/w-x", name: "w-x", version: "2.0.0" },
    ],
  );
  const allRefs = new Set([...componentRefs, bom.metadata.component["bom-ref"]]);
  const depRefs = new Set(bom.dependencies.map((d) => d.ref));
  // 每个实例（含根）都有一条依赖记录，且所有 dependsOn 引用存在。
  equal(depRefs.size, 4);
  for (const dep of bom.dependencies) {
    ok(allRefs.has(dep.ref), `未知引用 ${dep.ref}`);
    for (const target of dep.dependsOn) {
      ok(allRefs.has(target), `未知依赖引用 ${target}`);
    }
  }
  // 链接目标合并为单一实例，依赖边指向目标实例。
  const rootDeps = bom.dependencies.find((d) => d.ref === "pkg:.")!;
  deepEqual([...rootDeps.dependsOn].sort(), ["pkg:node_modules/a", "pkg:packages/w-x"]);
  const wxDeps = bom.dependencies.find((d) => d.ref === "pkg:packages/w-x")!;
  deepEqual(wxDeps.dependsOn, ["pkg:node_modules/a"]);
});

test("重复生成时同一安装位置保持同一引用", () => {
  const first = generateSbomFromLock(lock);
  const second = generateSbom(JSON.stringify(lock));
  deepEqual(second, first);
});

test("依赖闭环在 SBOM 中保留", () => {
  const cyclic: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { p: "1.0.0", q: "1.0.0" } },
      "node_modules/p": {
        name: "p",
        version: "1.0.0",
        peerDependencies: { q: "1.0.0" },
      },
      "node_modules/q": {
        name: "q",
        version: "1.0.0",
        peerDependencies: { p: "1.0.0" },
      },
    },
  };
  const bom = generateSbomFromLock(cyclic);
  const pDeps = bom.dependencies.find((d) => d.ref === "pkg:node_modules/p")!;
  const qDeps = bom.dependencies.find((d) => d.ref === "pkg:node_modules/q")!;
  deepEqual(pDeps.dependsOn, ["pkg:node_modules/q"]);
  deepEqual(qDeps.dependsOn, ["pkg:node_modules/p"]);
});
