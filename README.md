# ForgeKit 本地审批流库

TypeScript 实现的本地审批流库，由上层业务直接调用，持久状态存入 SQLite（使用 Node.js 内置 `node:sqlite`，无原生依赖）。操作者身份由上层核实，库内不做鉴权。

## 要求

- Node.js >= 23.4（内置 `node:sqlite` 免标志可用）
- `npm install` 后 `npm test` 即可运行全部测试；`npm run build` 产出 `dist/`

## 能力

- `submit(input)`：提交实例。给出的发起人、变更字段数、普通层与高级层审批人名单。字段数 ≤ 50 只走普通层，> 50 先普通层再高级层；路径在提交时固定。
- `act({ todoId, operator, action })`：办理审批动作（`approve` / `reject`），只能针对操作者当前有效待办；已办理或已失效待办再次提交不改变实例。
- `addApprover(instanceId, layerSeq, person)`：加签，在指定层增加审批人。
- `reassign(instanceId, layerSeq, fromPerson, toPerson)`：改派，替换该层一名审批人。
- `withdraw(instanceId, operator)`：发起人撤回。
- `getInstance(instanceId)`：查看实例（状态、各层审批人及同意情况）。
- `listTodos(person)`：查询个人当前待办，恰好包含该人现在能办理的事项。

## 规则摘要

- 每层全员同意才算完成；仅当前最早未完成层产生有效待办，后续层不得提前办理；同一人可参与不同层。
- 加签/改签只作用于未终结实例的当前层或已完成层，不能修改未来层。
- 加签/改派后，受影响层其他人的既有同意与待办保持有效，新增/替换的人必须重新同意；若该层原已完成，实例退回该层，其后所有层的同意作废、已签发待办失效，待该层重新完成后后续层依次重新审批。
- 改派后原审批人的待办与同意失效；失效待办不能再次办理，即使同一人后来被重新分配到同一实例同一层，也必须使用新待办。
- 任一有效驳回使实例终结为驳回；发起人撤回使实例终结为撤回；最后一层完成使实例终结为通过。终态没有有效待办，不能再加签、改派或改变结果。

## 示例

```ts
import { ApprovalService } from 'forgekit-approval';

const svc = new ApprovalService('./approval.db');
const id = svc.submit({
  initiator: 'alice',
  fieldCount: 60,
  normalApprovers: ['bob', 'carol'],
  seniorApprovers: ['dave'],
});
const [todo] = svc.listTodos('bob');
svc.act({ todoId: todo.id, operator: 'bob', action: 'approve' });
svc.close();
```
