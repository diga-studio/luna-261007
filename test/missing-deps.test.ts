import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSbom, PackageLock } from "../src/index";
import { summarize } from "./helpers";

// 可选依赖缺失：不生成虚构组件或依赖边。
// - miss-opt 同时在 dependencies 与 optionalDependencies 中：optional 覆盖，可缺失。
// - miss-peer 是 optional 为 true 的 peer：可缺失。
const optionalLock: PackageLock = {
  name: "opt-app",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "opt-app",
      version: "1.0.0",
      dependencies: { "miss-opt": "^1.0.0", real: "^1.0.0" },
      optionalDependencies: { "miss-opt": "^1.0.0" },
      peerDependencies: { "miss-peer": "^1.0.0" },
      peerDependenciesMeta: { "miss-peer": { optional: true } },
    },
    "node_modules/real": { version: "1.0.0" },
  },
};

test("可选依赖与可选peer缺失时静默跳过", () => {
  const bom = generateSbom(optionalLock);
  assert.deepStrictEqual(summarize(bom), {
    metadata: { ref: "sbom:component:root", type: "application", name: "opt-app", version: "1.0.0" },
    components: [{ ref: "sbom:component:node_modules/real", name: "real", version: "1.0.0" }],
    deps: [
      { ref: "sbom:component:node_modules/real", dependsOn: [] },
      { ref: "sbom:component:root", dependsOn: ["sbom:component:node_modules/real"] },
    ],
  });
});

test("非可选依赖找不到可见实例时必须失败", () => {
  const base: PackageLock = {
    name: "bad-app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "bad-app", version: "1.0.0", dependencies: { ghost: "^1.0.0" } },
    },
  };
  assert.throws(() => generateSbom(base), /cannot resolve dependency "ghost"/);
});

test("非可选peer缺失时必须失败", () => {
  const lock: PackageLock = {
    name: "bad-peer",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "bad-peer", version: "1.0.0", dependencies: { lib: "^1.0.0" } },
      "node_modules/lib": { version: "1.0.0", peerDependencies: { gone: "^2.0.0" } },
    },
  };
  assert.throws(() => generateSbom(lock), /cannot resolve dependency "gone"/);
});

test("别处的同名嵌套包对当前声明者不可见时必须失败", () => {
  const lock: PackageLock = {
    name: "scope-app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "scope-app", version: "1.0.0", dependencies: { a: "^1.0.0", c: "^1.0.0" } },
      "node_modules/a": { version: "1.0.0", dependencies: { hidden: "^1.0.0" } },
      "node_modules/a/node_modules/hidden": { version: "1.0.0" },
      "node_modules/c": { version: "1.0.0", dependencies: { hidden: "^1.0.0" } },
    },
  };
  assert.throws(() => generateSbom(lock), /cannot resolve dependency "hidden".*"node_modules\/c"/);
});

test("不支持的lockfileVersion必须失败", () => {
  const lock = { lockfileVersion: 2, packages: { "": {} } } as unknown as PackageLock;
  assert.throws(() => generateSbom(lock), /unsupported lockfileVersion/);
});
