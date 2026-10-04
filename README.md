# task26100720

TypeScript 工作流执行库：条件分支 + 循环，流程定义以 JSON 传入，运行状态与记录保存在内存。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

## API

```ts
import { runWorkflow } from "./src/index";

const result = await runWorkflow(def, handlers, input, timeoutMs);
// result: { status: "success" | "failed" | "timeout", output, records }
```

- `def: WorkflowDef` — `{ nodes, edges }`。节点类型：`task` / `decision`（均带 `handler` 名）与 `loop`（带 `body` 子图，子图内不得再有 loop）。边 `{ from, to, when? }`，`when` 仅用于判断节点的出边。
- `handlers: Record<string, (input: JsonValue) => Promise<JsonValue>>` — 调用方提供的异步处理器；判断节点处理器须返回布尔值。
- `input: JsonValue` — 运行初始输入，交给外层图全部根节点。
- `timeoutMs: number` — 整次运行时限，覆盖排队与全部循环迭代。

## 语义要点

- 工作节点成功后激活全部出边；判断节点只激活与返回值相符的出边，其余失活。
- 非根节点等所有入边确定后：至少一条激活才执行（输入为 `{ 源节点id: 源输出 }`，仅含激活入边），否则跳过并使全部出边失活。每个节点实例至多执行一次。
- 循环节点恰有一条入边，上游输出须为数组；每个元素触发一次循环体执行，迭代间状态完全隔离，结果按输入顺序排列；空数组立即成功输出 `[]`。
- 每次迭代的结果为 `{ 节点id: 输出 }`，只含成功节点；跳过节点不占位。
- 首次处理器失败或到达时限即结束运行（`failed` / `timeout`）：保留已有终态，未结束实例记为 `cancelled`，停止启动新实例；迟到的处理器结果被忽略，不会改动记录或产生未处理的异步错误。
- `records` 中循环体节点带 `loopId` 与 `iteration`，同名节点不会覆盖其他迭代的记录。
