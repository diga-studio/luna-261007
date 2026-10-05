# crew-dispatch-recommender

班组派工推荐库（TypeScript）。由上层调度系统调用，名册保存在进程内内存中。
对每张工单，在全部合法班组中返回**总代价最低的精确最优方案**（不是个人排名、不是启发式）。

## 构建与测试

只依赖 Node.js 与 npm 开发依赖（typescript）：

```bash
npm install
npm test        # tsc 编译 + 运行全部自动化测试
npm run build   # 仅编译到 dist/
```

## 用法

```ts
import { CrewPlanner } from "crew-dispatch-recommender";

const planner = new CrewPlanner();
planner.replaceRoster(workers);          // 整体替换名册（<= 200 人）
const result = planner.recommend(order, contexts);
if (result.ok) {
  // result.members: 成员编号升序；result.leader: 领班编号；result.totalCost: 总代价
} else {
  // result.reason === "no-feasible-crew"：明确无解，不少覆盖技能、不放宽资格
}
```

- `replaceRoster(workers)`：整体替换工人名册，仅在推荐调用之间发生。
- `recommend(order, contexts)`：基于当前完整名册为一张工单推荐班组。
  `contexts` 是上层为每位工人提供的现场结论（时段可用性、单程里程、往返分钟数）。

## 业务规则要点

- 入选资格：时段可用、单程里程不超过个人出勤半径、未避配该客户、
  当天已排分钟数 + 本次工作分钟数 ≤ 600。
- 技能有效：证书到期时刻 ≥ 工单结束时刻；某项证书失效不影响其他有效技能。
- 班组：2 至 8 名不同工人，至少一人可任领班，覆盖全部必需技能；
  领班为成员中编号最小的可任领班者。
- 个人代价 = 往返行程分钟数 + 当天已排工作分钟数 + (100 − 信用分)。
- 最优性：总代价最小；并列时人数较少优先；再并列时成员编号升序序列字典序最小。

## 实现与复杂度

- 候选按 (有效技能掩码, 可任领班) 分组剪枝（组内只留代价最小两人），
  再按 (技能覆盖掩码 2^16, 是否含领班, 人数 0..8) 做精确动态规划。
- 单次推荐：200 人、16 项必需技能、候选大量共享技能场景下实测约 80ms、
  堆增量约 10 MiB（上限分别为 5s、256 MiB）；200 人技能互异的退化场景约 0.9s。
- 测试：小规模确定性用例（含“最便宜的工人不属于最优班组”、总代价并列等）、
  500 组随机场景与暴力枚举参照逐位一致、200 人规模有解（已知最优答案）与无解场景。
