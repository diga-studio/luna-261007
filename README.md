# layer-cache-build

多阶段镜像构建的层缓存库（TypeScript），不依赖 Docker，缓存持久化在本地文件系统，跨实例保留。

## 使用

```ts
import { createBuilder } from "layer-cache-build";

const builder = createBuilder({
  cacheDir: "/path/to/cache",
  run: async (command, tree) => {
    // 确定性函数：根据命令与只读文件树，返回写入与删除
    return { writes: { "/out.txt": new Uint8Array(...) }, deletes: ["/tmp/x"] };
  },
});

const imageId = await builder.build(plan, context, "target-stage");
const bytes = await builder.readFile(imageId, "/out.txt");
```

- `context` 与镜像均为「规范化绝对路径 -> 原始字节」的文件树，无权限、目录元数据与符号链接。
- `plan` 由具名阶段组成；阶段从空树或另一阶段的最终树开始，顺序执行 `COPY` 与 `RUN`。
- 只执行目标阶段及其必要依赖。

## 缓存设计

- `RUN` 层键 = SHA-256(command + 执行前完整文件树的内容哈希)。命令与输入树完全相同才复用，且命中时还原完整输出（含删除效果），不调用 `run`。
- 层记录、文件 blob（按内容寻址）、镜像清单均存于 `cacheDir`（`layers/`、`blobs/`、`images/`），跨实例保留。
- 缓存键不含阶段名与阶段顺序，因此阶段改名、独立阶段重排不失效；`COPY` 未选中的来源文件变化不会进入消费者树，自然不会导致下游重建。
- `imageId` = 最终树的内容哈希，相同最终树产生相同 `imageId`。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`npm test` 先以 `tsc` 编译再运行 `node --test`。
