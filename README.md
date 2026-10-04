# sod-precheck

临时访问授权的**职责分离（SoD）预检库**，由身份治理流程在进程内直接调用。
组织、授权与已批准豁免以快照形式存于内存，无接口层、无外部服务依赖。

## 能力

- **预检 `precheck`**：在调用方指定的有限查询范围（最长 10 年）内，报告所有
  未被豁免覆盖的冲突。对每名员工、每个资源、每对互斥角色，输出**最大连续冲突时段**：
  重叠或首尾相接的冲突合并，豁免覆盖部分扣除（可能因此拆段），授权来源变化但冲突
  不中断时不拆段。
- **角色查看 `rolesAt`**：在同一候选方案下，查看指定员工在某资源、某时刻实际拥有的角色。
- **候选方案**：调整（新增授权 / 按标识撤回授权）只在分析时生效，**不修改原快照**；
  只判断整组调整完成后的状态。撤回一个来源不会消除其他来源仍提供的角色。

## 业务语义

- 时间为整数毫秒；所有时段为 `[start, end)`，结束时刻不包含；`end` 缺省表示无限期。
- 授权目标为员工或组织节点；组织授权对该节点及**全部后代**（深度不限）的员工生效。
  同一角色来自不同来源的重叠授权取并集，任一来源有效则角色有效。
- 互斥角色对无序；同一员工在**同一资源**上同时拥有某对角色才构成冲突，跨资源不算。
- 豁免精确绑定员工、资源、互斥角色对与时段；多个豁免的覆盖取并集，不外溢。
  豁免只影响冲突判断，不改变员工实际拥有的角色（`rolesAt` 不受豁免影响）。

## 使用

```ts
import { Snapshot, precheck, rolesAt } from 'sod-precheck';

const snapshot = new Snapshot({
  employees,   // { id, orgNodeId }
  orgNodes,    // { id, parentId }，森林，深度不限
  grants,      // { id, target, roleId, resourceId, range }
  policy,      // { mutexPairs: [{ roleA, roleB }] }
  exemptions,  // { id, employeeId, resourceId, roleA, roleB, range }
});

const result = precheck(snapshot, {
  range: { start: t0, end: t1 },          // 必须有限，跨度 ≤ 10 年
  adjustment: {                            // 可选：候选方案
    addedGrants: [/* 新增授权 */],
    removedGrantIds: ['G123'],
  },
});
// result.conflicts: [{ employeeId, resourceId, roleA, roleB, start, end }]

const roles = rolesAt(snapshot, 'E1', 'RES1', t, /* 可选 adjustment */);
```

## 性能

按资源对组织树做一次 DFS，沿途维护祖先授权区间栈，在员工处合并个人授权后
按互斥对求交、扣豁免。处理量取决于授权/豁免/冲突事件数，**与查询范围经过的
毫秒数无关**；毫秒级短暂冲突同样被发现。

在 2000 员工 / 4000 组织节点 / 50 角色 / 20 资源 / 100000 授权 / 10000 豁免、
报告 4000 段的规模下，本仓库性能测试实测约 **120ms**、堆内存约 **35MiB**
（限制：5 秒 / 256MiB / ≤10000 段）。性能测试在 `--max-old-space-size=224`
的受限堆子进程中运行，超限即失败。

## 测试

```sh
npm install
npm test
```

仅需 Node.js；`typescript` 与 `@types/node` 为 devDependencies，无运行时依赖。
测试包含：区间工具单测、业务规则测试（祖先/个人授权交叠、撤回后角色仍有效、
首尾相接合并、跨资源、多豁免拆分、未来生效、无限期、快照不可变等）、
400 个随机小案例与独立参考实现的逐段比对（含 `rolesAt` 逐毫秒比对）、
以及上述规模的耗时与内存验证。
