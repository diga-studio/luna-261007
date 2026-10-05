# lock-sbom

离线 Node.js 依赖还原库：以本地 `package-lock.json`（lockfileVersion 3，含 `packages`）为唯一数据来源，生成 CycloneDX 1.5 JSON 格式的 SBOM。由上层调用，不访问网络。

## 使用

```ts
import { generateSbom } from "lock-sbom";
import { readFileSync } from "node:fs";

const bom = generateSbom(readFileSync("package-lock.json", "utf8"));
// 或直接传入解析后的对象：generateSbom(lockObject)
```

返回值为 CycloneDX 1.5 BOM 对象（`JSON.stringify` 即可落盘）：

- `metadata.component`：项目根（锁文件 `packages` 的空字符串键）。
- `components`：从根出发运行时可达的全部安装实例，与实例一一对应。
- `dependencies`：每个实例（含根）的依赖引用闭包；所有被引用的 `bom-ref` 都保证存在。

## 解析规则

- 运行时依赖取 `dependencies` + `optionalDependencies` + `peerDependencies`；同名 optional 覆盖 dependencies；`devDependencies` 不参与。
- 依赖目标按 Node.js 裸包名的就近安装可见性确定（从声明者目录逐级向上查 `node_modules/<安装名>`），不按版本范围重新选包；别处存在同名包不代表当前声明者可用。
- `link` 条目沿 `resolved` 指向工作区目标；多个链接指向同一目标时合并为同一实例，目标自身的依赖按其真实目录解释。
- 依赖声明的键是安装名（npm 别名按此名查找）；组件真实名称取目标条目的 `name`，缺省时取完整安装名（保留作用域）；版本取目标条目的 `version`。同名同版本但安装位置不同的包保留为不同实例。
- `optionalDependencies` 及 `peerDependenciesMeta` 中 `optional: true` 的 peer 允许缺失（不生成虚构组件或边）；其他声明找不到可见实例时抛错，不产出表示成功的 SBOM。
- `bom-ref` 由安装路径派生（`sbom:component:<路径>`，根为 `sbom:component:root`），安装位置未变的实例重复生成时引用不变；共享关系与闭环原样保留。

## 构建与测试

```sh
npm install
npm test        # tsc 构建 + node --test 运行全部测试
```

仅依赖 Node.js（>= 18）与 `devDependencies` 中的 `typescript`、`@types/node`，不需要任何外部服务。

## 目录结构

- `src/types.ts`：锁文件、实例图、CycloneDX 类型定义。
- `src/resolve.ts`：从锁文件构建运行时可达的安装实例图（就近可见性、link 归一、别名）。
- `src/sbom.ts`：实例图到 CycloneDX 1.5 BOM 的转换。
- `src/index.ts`：公开入口 `generateSbom`。
- `test/`：自动化测试，样例的实例与依赖关系与独立列出的预期整体比对。
