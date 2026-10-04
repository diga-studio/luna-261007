# workflow-engine

一个内存中的条件分支与循环工作流执行库（TypeScript）。流程定义以 JSON 传入，
运行状态与记录全部保存在内存，由上层直接调用 `runWorkflow`。

## 使用

```ts
import { runWorkflow } from 'workflow-engine';

const result = await runWorkflow(graph, {
  handlers,   // 每个工作/判断节点的异步处理器，按节点 id 关联
  input,      // 运行初始输入（外层根节点接收）
  timeoutMs,  // 整次运行时限，覆盖排队与全部循环迭代
});
```

- 图定义 `GraphDef`：`nodes`（`work` / `decision` / `loop`）与 `edges`
  （判断节点的出边带 `on: boolean`）。输入须为合法 DAG；循环体也是 DAG，
  且不含循环节点。
- 处理器：根节点接收运行输入（循环体根节点接收当前元素）；其余节点接收
  按源节点 id 关联的激活入边源输出对象。判断处理器返回布尔值。
- 返回 `RunResult`：`status`（`success` / `failed` / `timeout`）、
  `output`（外层成功节点的输出，按节点 id 关联）、`records`（每个节点
  实例一条记录，含 `scope` 区分所属循环与迭代序号）。

## 语义要点

- 非根节点等全部入边确定后：至少一条激活才执行（仅接收激活入边的源输出），
  否则跳过并使全部出边失活；每个节点实例至多执行一次。
- 循环节点恰有一条入边，上游输出为数组；每个元素触发一次循环体执行，
  迭代间状态完全隔离；循环输出按输入元素顺序排列各迭代成功节点的输出。
- 首次处理器失败或到达时限即结束运行：保留已有终态，未结束实例记为
  `cancelled`，不再启动新实例；迟到返回的处理器结果被忽略。

## 构建与测试

```sh
npm install
npm test        # 编译 src 与 test 后用 node:test 运行
npm run build   # 仅编译库到 dist/
```

要求 Node.js >= 22，无其他运行时依赖。
