import { test } from "node:test";
import { deepEqual, throws } from "node:assert/strict";
import { resolveInstances } from "../src/resolve";
import { PackageLock } from "../src/types";

/** 把实例图归一化为可比较的普通对象：id -> { name, version, deps(排序后) }。 */
function normalize(lock: PackageLock): Record<string, { name: string; version: string; deps: string[] }> {
  const instances = resolveInstances(lock);
  const out: Record<string, { name: string; version: string; deps: string[] }> = {};
  for (const inst of instances) {
    out[inst.id] = {
      name: inst.name,
      version: inst.version,
      deps: inst.dependencies.map((d) => d.id).sort(),
    };
  }
  return out;
}

test("嵌套同名不同版本：就近选择目标，不可达实例不输出", () => {
  const lock: PackageLock = {
    name: "root-app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "root-app",
        version: "1.0.0",
        dependencies: { a: "^1.0.0" },
      },
      "node_modules/a": {
        name: "a",
        version: "1.0.0",
        dependencies: { b: "^1.0.0" },
      },
      "node_modules/a/node_modules/b": { name: "b", version: "1.0.0" },
      // 根层存在同名不同版本的 b，但 a 必须优先使用嵌套副本；
      // 根层 b 对运行时不可达，不得出现在结果中。
      "node_modules/b": { name: "b", version: "2.0.0" },
    },
  };
  deepEqual(normalize(lock), {
    "": { name: "root-app", version: "1.0.0", deps: ["node_modules/a"] },
    "node_modules/a": {
      name: "a",
      version: "1.0.0",
      deps: ["node_modules/a/node_modules/b"],
    },
    "node_modules/a/node_modules/b": { name: "b", version: "1.0.0", deps: [] },
  });
});

test("同名同版本不同安装位置：保留为不同实例", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { x: "1.0.0", y: "1.0.0" } },
      "node_modules/x": {
        name: "x",
        version: "1.0.0",
        dependencies: { dup: "1.0.0" },
      },
      "node_modules/y": {
        name: "y",
        version: "1.0.0",
        dependencies: { dup: "1.0.0" },
      },
      "node_modules/x/node_modules/dup": { name: "dup", version: "1.0.0" },
      "node_modules/y/node_modules/dup": { name: "dup", version: "1.0.0" },
    },
  };
  deepEqual(normalize(lock), {
    "": { name: "", version: "", deps: ["node_modules/x", "node_modules/y"] },
    "node_modules/x": {
      name: "x",
      version: "1.0.0",
      deps: ["node_modules/x/node_modules/dup"],
    },
    "node_modules/y": {
      name: "y",
      version: "1.0.0",
      deps: ["node_modules/y/node_modules/dup"],
    },
    "node_modules/x/node_modules/dup": { name: "dup", version: "1.0.0", deps: [] },
    "node_modules/y/node_modules/dup": { name: "dup", version: "1.0.0", deps: [] },
  });
});

test("npm 别名与作用域别名：按安装名查找，真实名称取目标条目 name", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: {
          "alias-b": "npm:b@2.0.0",
          "@alias/tool": "npm:@scope/tool@1.0.0",
        },
      },
      "node_modules/alias-b": { name: "b", version: "2.0.0" },
      "node_modules/@alias/tool": { name: "@scope/tool", version: "1.0.0" },
    },
  };
  deepEqual(normalize(lock), {
    "": {
      name: "",
      version: "",
      deps: ["node_modules/@alias/tool", "node_modules/alias-b"],
    },
    "node_modules/alias-b": { name: "b", version: "2.0.0", deps: [] },
    "node_modules/@alias/tool": { name: "@scope/tool", version: "1.0.0", deps: [] },
  });
});

test("条目缺省 name 时取完整安装名，作用域不丢失", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "@scope/pkg": "1.0.0" } },
      "node_modules/@scope/pkg": { version: "1.2.3" },
    },
  };
  deepEqual(normalize(lock), {
    "": { name: "", version: "", deps: ["node_modules/@scope/pkg"] },
    "node_modules/@scope/pkg": { name: "@scope/pkg", version: "1.2.3", deps: [] },
  });
});

test("工作区链接：目标依赖按真实目录解释，多链接合并为同一实例", () => {
  const lock: PackageLock = {
    name: "root-app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "root-app",
        version: "1.0.0",
        dependencies: { "w-a": "1.0.0", "w-b-second-link": "1.0.0" },
      },
      "node_modules/w-a": { resolved: "packages/w-a", link: true },
      "node_modules/w-b-second-link": { resolved: "packages/w-b", link: true },
      "packages/w-a": {
        name: "w-a",
        version: "1.0.0",
        dependencies: { "w-b": "1.0.0" },
      },
      // w-a 真实目录下可见的链接，同样指向 packages/w-b。
      "packages/w-a/node_modules/w-b": { resolved: "../../w-b", link: true },
      "packages/w-b": { name: "w-b", version: "1.0.0" },
    },
  };
  deepEqual(normalize(lock), {
    "": {
      name: "root-app",
      version: "1.0.0",
      deps: ["packages/w-a", "packages/w-b"],
    },
    "packages/w-a": { name: "w-a", version: "1.0.0", deps: ["packages/w-b"] },
    "packages/w-b": { name: "w-b", version: "1.0.0", deps: [] },
  });
});

test("peer 闭环保留，optional peer 与 optionalDependencies 可缺失", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: { "w-a": "1.0.0" },
        optionalDependencies: { "opt-missing": "^1.0.0" },
      },
      "node_modules/w-a": { resolved: "packages/w-a", link: true },
      "packages/w-a": {
        name: "w-a",
        version: "1.0.0",
        peerDependencies: { "w-b": "1.0.0", "peer-missing": "*" },
        peerDependenciesMeta: { "peer-missing": { optional: true } },
      },
      "node_modules/w-b": { resolved: "packages/w-b", link: true },
      "packages/w-b": {
        name: "w-b",
        version: "1.0.0",
        peerDependencies: { "w-a": "1.0.0" },
      },
    },
  };
  // 闭环 w-a <-> w-b 必须保留；可缺失的声明不产生实例与边。
  deepEqual(normalize(lock), {
    "": { name: "", version: "", deps: ["packages/w-a"] },
    "packages/w-a": { name: "w-a", version: "1.0.0", deps: ["packages/w-b"] },
    "packages/w-b": { name: "w-b", version: "1.0.0", deps: ["packages/w-a"] },
  });
});

test("optionalDependencies 覆盖同名 dependencies", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": {
        dependencies: { maybe: "^1.0.0" },
        optionalDependencies: { maybe: "^1.0.0" },
      },
      // maybe 未安装：因 optionalDependencies 覆盖，允许缺失。
    },
  };
  deepEqual(normalize(lock), {
    "": { name: "", version: "", deps: [] },
  });
});

test("devDependencies 不参与解析", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": { devDependencies: { "dev-tool": "^1.0.0" } },
      "node_modules/dev-tool": { name: "dev-tool", version: "1.0.0", dev: true },
    },
  };
  deepEqual(normalize(lock), {
    "": { name: "", version: "", deps: [] },
  });
});

test("必需依赖找不到可见实例时抛错", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { ghost: "^1.0.0" } },
    },
  };
  throws(() => resolveInstances(lock), /ghost/);
});

test("非 optional 的 peer 缺失时抛错", () => {
  const lock: PackageLock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { p: "1.0.0" } },
      "node_modules/p": {
        name: "p",
        version: "1.0.0",
        peerDependencies: { "peer-required": "*" },
      },
    },
  };
  throws(() => resolveInstances(lock), /peer-required/);
});
