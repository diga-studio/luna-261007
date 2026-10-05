# task26100739

入职旅程的依赖完成状态引擎（TypeScript，进程内库）。

## API

- `createJourney(tasks)`：用任务 ID 与直接前置任务 ID 列表创建旅程；任务图创建后固定，输入须为 DAG。
- `applyCompletions(journey, changes)`：把 `changes`（任务 ID → 布尔值）作为一批赋值同时生效，返回批次前后可见状态发生变化的任务列表（`{ id, from, to }`）。
- `visibleState(journey, id)`：查询单个任务的可见状态（`locked` / `ready` / `completed`）。

语义：每个任务保存独立的完成声明（初始 `false`）。有效完成 = 自身声明为 `true` 且所有直接前置任务均有效完成。有前置未有效完成时可见状态为 `locked`，否则按自身声明为 `completed` 或 `ready`。锁定期间的声明会被保存，条件恢复后自动恢复有效完成。

## 构建与测试

```sh
npm install
npm test
```
