# sod-precheck

临时访问授权的职责分离（SoD）预检库，由身份治理流程直接调用。
组织、授权和已批准豁免均以快照形式存于进程内存，无接口层、无外部服务依赖。

## 快速开始

```bash
npm install
npm test
```

仅需 Node.js；`npm test` 会先编译 TypeScript 再运行全部测试（含规模性能验证）。

## API

```ts
import { createSnapshot, applyAdjustments, precheck } from 'sod-precheck';

const snapshot = createSnapshot({ employees, orgNodes, grants, exemptions });

// 预检：整组调整完成后的候选方案，返回查询范围内所有未被豁免覆盖的冲突
const conflicts = precheck(snapshot, adjustments, policy, { start, end });

// 核对：候选方案下某员工在某资源、某时刻实际拥有的角色
const view = applyAdjustments(snapshot, adjustments);
const roles = view.rolesAt('emp-1', 'res-1', at);
```

- `precheck` 返回 `ConflictSegment[]`：按员工、资源、互斥角色对输出的最大连续冲突时段，
  重叠或首尾相接的段已合并，豁免覆盖部分已扣除（可能因此拆成多段）。
- 查询范围为 `[start, end)`，整数毫秒，最长 10 年（`MAX_RANGE_MS`）。
- 授权/豁免的 `end` 缺省表示长期（无结束时刻），预检时按查询范围截断。
- 组织授权对节点及全部后代生效，层级深度不限。
- 调整只作用于候选视图，原快照保持不变（测试中以深度冻结验证）。

## 设计要点

- **角色有效性**：同一角色的多个来源按区间并集处理，任一来源有效即角色有效；
  撤回一个来源不影响其他来源。
- **冲突检测**：对每个 (员工, 资源) 求互斥角色对两侧有效时段的交集，
  再扣除该 (员工, 资源, 角色对) 精确绑定的豁免时段。
- **性能**：组织树自根向下 DFS，沿路径增量维护 `(资源, 角色) -> 有效时段` 的合并结果
  （进入节点合并、离开节点回滚），共享祖先授权只计算一次；
  全部操作为区间级，处理量不随查询范围内经过的毫秒数增长。
- **规模验证**（`test/perf.test.ts`）：2000 员工、4000 节点、50 角色、20 资源、
  100000 授权、10000 豁免、10 年范围，预检耗时与堆内存均远优于 5s / 256 MiB 上限。

## 正确性验证

- `test/precheck.test.ts`：祖先与个人授权交叠、撤回后角色仍有效、首尾相接合并、
  跨资源不冲突、多豁免交叠扣除、未来生效授权、快照不可变等场景。
- 随机小规模案例与独立参考实现（`test/helpers.ts`，按业务定义用边界点暴力计算）逐段比对一致。
