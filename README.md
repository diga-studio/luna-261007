# layer-cache-build

多阶段镜像构建的层缓存库（TypeScript）。提供 `build(plan, context, target)` 与
`readFile(imageId, path)`，缓存持久化在本地目录，跨实例保留。

## 使用

```ts
import { createBuilder } from 'layer-cache-build';

const builder = createBuilder({
  cacheDir: '/path/to/cache',
  // 确定性异步函数：给定命令与只读文件树，返回写入与删除。
  run: async (command, tree) => ({
    writes: new Map([['/out/result.txt', new TextEncoder().encode('...')]]),
    deletes: ['/tmp/scratch'],
  }),
});

const imageId = await builder.build(plan, context, 'target-stage');
const bytes = await builder.readFile(imageId, '/out/result.txt');
```

- `context` 与镜像均为 `Map<规范化绝对路径, Uint8Array>`，无权限、目录元数据与符号链接。
- `plan.stages` 为具名阶段；`from` 指定起始阶段（缺省为空树），步骤为 `COPY` 与 `RUN`。
- `COPY` 从 context（缺省）或 `from` 阶段的最终树复制文件/目录子树；覆盖同名文件，保留其余。
- `RUN` 的缓存键只由命令字符串与执行前文件树决定：命中时不调用 `run`，并完整还原写入与删除效果。
- 相同最终树产生相同 `imageId`。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js（>= 18）与 devDependency `typescript`；测试使用内置 `node:test`。
