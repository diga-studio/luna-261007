import { test } from "node:test";
import assert from "node:assert/strict";
import { generateSbom, PackageLock } from "../src/index";
import { summarize } from "./helpers";

// 嵌套同名不同版本 + npm 别名（含作用域别名）。
// 独立预期：
// - a 的 b 解析到 node_modules/a/node_modules/b@1.0.0（就近），而不是根层 b@2.0.0。
// - alias-b 与 b 真实名都是 b@2.0.0，但安装位置不同，必须是两个实例。
// - @scope/alias 与 @scope/real 真实名都是 @scope/real@1.2.3，作用域不丢失，两个实例。
// - dev-only（devDependencies）与 stray（无人引用）不可达，不出现。
const lock: PackageLock = {
  name: "app",
  version: "1.0.0",
  lockfileVersion: 3,
  packages: {
    "": {
      name: "app",
      version: "1.0.0",
      dependencies: {
        a: "^1.0.0",
        b: "^2.0.0",
        "alias-b": "npm:b@^2.0.0",
        "@scope/real": "^1.0.0",
        "@scope/alias": "npm:@scope/real@^1.0.0",
      },
      devDependencies: { "dev-only": "^9.9.9" },
    },
    "node_modules/a": {
      version: "1.0.0",
      dependencies: { b: "^1.0.0" },
    },
    "node_modules/a/node_modules/b": { version: "1.0.0" },
    "node_modules/b": { version: "2.0.0" },
    "node_modules/alias-b": { name: "b", version: "2.0.0" },
    "node_modules/@scope/real": { version: "1.2.3" },
    "node_modules/@scope/alias": { name: "@scope/real", version: "1.2.3" },
    "node_modules/dev-only": { version: "9.9.9", dev: true },
    "node_modules/stray": { version: "0.0.1" },
  },
};

test("嵌套同名不同版本与作用域别名：目标选择与真实名称", () => {
  const bom = generateSbom(lock);
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.5");

  assert.deepStrictEqual(summarize(bom), {
    metadata: { ref: "sbom:component:root", type: "application", name: "app", version: "1.0.0" },
    components: [
      { ref: "sbom:component:node_modules/@scope/alias", name: "@scope/real", version: "1.2.3" },
      { ref: "sbom:component:node_modules/@scope/real", name: "@scope/real", version: "1.2.3" },
      { ref: "sbom:component:node_modules/a", name: "a", version: "1.0.0" },
      { ref: "sbom:component:node_modules/a/node_modules/b", name: "b", version: "1.0.0" },
      { ref: "sbom:component:node_modules/alias-b", name: "b", version: "2.0.0" },
      { ref: "sbom:component:node_modules/b", name: "b", version: "2.0.0" },
    ],
    deps: [
      { ref: "sbom:component:node_modules/@scope/alias", dependsOn: [] },
      { ref: "sbom:component:node_modules/@scope/real", dependsOn: [] },
      {
        ref: "sbom:component:node_modules/a",
        dependsOn: ["sbom:component:node_modules/a/node_modules/b"],
      },
      { ref: "sbom:component:node_modules/a/node_modules/b", dependsOn: [] },
      { ref: "sbom:component:node_modules/alias-b", dependsOn: [] },
      { ref: "sbom:component:node_modules/b", dependsOn: [] },
      {
        ref: "sbom:component:root",
        dependsOn: [
          "sbom:component:node_modules/@scope/alias",
          "sbom:component:node_modules/@scope/real",
          "sbom:component:node_modules/a",
          "sbom:component:node_modules/alias-b",
          "sbom:component:node_modules/b",
        ],
      },
    ],
  });
});

test("重复生成：安装位置未变的实例保持同一引用", () => {
  assert.deepStrictEqual(generateSbom(lock), generateSbom(lock));
});
