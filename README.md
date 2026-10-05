# lockfile-sbom

离线 Node.js 依赖还原库：以本地 `package-lock.json`（lockfileVersion 3，含 `packages`）为唯一数据来源，生成 CycloneDX 1.5 JSON 格式的 SBOM。由上层调用，不访问网络。

## 使用

```ts
import { generateSbom, generateSbomFromLock } from "lockfile-sbom";
import { readFileSync } from "node:fs";

const bom = generateSbom(readFileSync("package-lock.json", "utf8"));
// 或传入已解析的对象：generateSbomFromLock(lock)
```

返回值为 CycloneDX 1.5 JSON 对象（`JSON.stringify` 即可落盘）：

- `metadata.component`：项目根（`packages[""]`），`type: "application"`。
- `components`：从根出发运行时可达的每个安装实例一个组件，`type: "library"`。
- `dependencies`：每个实例（含根）一条记录，`dependsOn` 为其直接依赖实例的 `bom-ref`。
- `bom-ref` 由安装路径派生（`pkg:<安装路径>`），安装位置不变时重复生成引用保持稳定。

## 解析规则

- 运行时依赖取 `dependencies`、`optionalDependencies`（同名覆盖 `dependencies`）与 `peerDependencies`；`devDependencies` 不参与。
- 依赖目标按 Node.js 裸包名的就近安装可见性确定（从声明者真实目录逐级向上查找 `node_modules/<安装名>`），不按版本范围重新选包。
- `link` 条目经 `resolved` 指向工作区目标；多个链接指向同一目标时合并为同一实例，目标依赖按其真实目录解释。
- 依赖声明的键是安装名（npm 别名按此名查找）；组件真实名称取目标条目 `name`，缺省时取完整安装名（保留作用域）；版本取目标条目 `version`。
- `optionalDependencies` 及 `peerDependenciesMeta` 中 `optional: true` 的 peer 允许缺失；其他声明找不到可见实例时抛出错误，不产出 SBOM。
- 同名同版本但安装位置不同的包保留为不同实例；共享关系与依赖闭环完整保留。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js 与 TypeScript（devDependency），无运行时依赖。
