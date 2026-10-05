# task26100739
# journey-engine

入职旅程依赖完成状态引擎（进程内 TypeScript 库）。

## API

- `createJourney(tasks)`：以任务 ID 与直接前置任务 ID 创建固定任务图（DAG）。
- `applyCompletions(journey, changes)`：整批应用完成/撤销赋值，返回可见状态发生变化的任务列表。

可见状态：`locked`（有前置未有效完成）、`ready`、`completed`。
任务独立完成声明持久保存；锁定期间的声明在解除阻塞后自动生效。

## 开发

```sh
npm install
npm test
```
