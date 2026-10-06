# CartForge 团购周期排期检查库

由上层发布流程调用的进程内库：装入已发布排期集合，检查一条待发布排期是否与
既有排期冲突。检查不改变已发布数据。

## 使用

```ts
import { ScheduleStore } from "./src/index.js";

const store = new ScheduleStore(publishedSchedules); // 或 store.load(...)
const result = store.check(pendingSchedule);
if (!result.canPublish) {
  console.log(result.conflict);
  // earliestOverlapStartIsoUtc / earliestOverlapStartMinutesUtc: 全有效期内最早相交瞬间
  // existingScheduleId / sharedSku / pendingOpenDate / existingOpenDate
}
```

### 排期输入（`ScheduleInput`）

| 字段 | 说明 |
| --- | --- |
| `id` / `pickupPointId` | 排期标识 / 取货点标识 |
| `skus` | 1..8 个 SKU |
| `validFrom` / `validTo` | 有效起止日期（含端点，YYYY-MM-DD，2008..9999 年） |
| `anchorMonday` | 作为锚点的某个周一 |
| `intervalWeeks` | 重复间隔周数 N，1..52 |
| `weekdays` | 生成场次的星期几，0=周一 .. 6=周日 |
| `openTime` / `closeTime` | 本地开放/截止时间（HH:MM，精确到分钟） |
| `closeNextDay` | 截止是否在开放次日（否则同日截止须晚于开放） |
| `excludedDates` | 至多 64 个排除日期，仅取消这些日期原本会开启的场次 |

## 规则要点

- 两条排期冲突 ⟺ 取货点相同 ∧ 共享至少一个 SKU ∧ 销售窗口在真实时间上相交。
  窗口含开放瞬间、不含截止瞬间（首尾相接不冲突）。
- 只在锚点所在周及之后、距离锚点周数为 N 整数倍的周内，按选定星期几生成场次；
  有效期只限制开放所在日期，截止可以跨出有效期。
- 时区固定 America/Chicago：标准时 UTC-6、夏令时 UTC-5；3 月第二个星期日
  02:00→03:00，11 月第一个星期日 02:00→01:00，所有支持年份同一规则。
- 开放或截止落在春季不存在的本地时刻 → 整场取消；落在秋季重复时刻 →
  开放取较早真实瞬间、截止取较晚真实瞬间。

## 设计

不枚举场次（7992 年每周枚举在规模下不可行），而是数论求解：

- 窗口不足 48 小时 ⟹ 相交场次的开放日相差 ≤ 2 天；对每对星期几，满足同余
  条件的开放日差至多一个，候选开放日构成步长 `lcm(7N₁, 7N₂)` 的等差数列，
  最早候选由扩展欧几里得直接解出。
- 本地时钟重叠 ⟹ UTC 重叠（本地→UTC 映射严格单调），因此常规候选只需跳过
  被取消（排除日 / 春季缺口）的场次。
- UTC 重叠但本地不重叠只可能发生在 DST 转换日 ±4 天内（偏移差 ≤ 1 小时）；
  该格局与年份无关，用 400 年格里历周期 + 线性同余直接解出最早可行年份，
  长有效期完全无冲突的检查也能在毫秒内完成。

## 测试

```sh
npm install
npm test
```

覆盖：短/多年有效期随机排期与独立逐场核对对照（判定与最早相交瞬间一致）、
有效期末尾唯一冲突及排除后放行、春季缺失时刻取消、秋季重复小时真实相交、
远期（8888 年）冲突定位、输入校验，以及 30,000 条全有效期排期的装入耗时
（< 5s）、100 条检查总耗时（< 20s，含对抗性无冲突场景）与内存（< 256MiB）。
