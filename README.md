# CartForge 团购周期排期检查库

进程内的团购周期排期冲突检查库（TypeScript 实现，无运行时依赖）。
由上层发布流程调用：装入已发布排期集合后，逐条检查待发布排期；检查不改变已发布数据。

## 使用

```ts
import { ScheduleChecker } from "cartforge-schedule-checker";

const checker = new ScheduleChecker();
checker.loadPublished([/* 已发布排期 */]);

const result = checker.check(candidate);
if (result.ok) {
  // 可发布
} else {
  // result.earliestInstantUtc  全有效期内最早的相交瞬间（UTC，ISO 8601）
  // result.existingScheduleId  命中的既有排期
  // result.sharedSku           一个共享 SKU
  // result.candidateOpenDate / result.existingOpenDate  双方场次的开放日期
}
```

## 排期模型

- 每条排期关联一个取货点和最多 8 个 SKU。
- 有效起止日期（含）只限制开放所在日期；截止可跨出有效期。
- 重复规则：锚点周一 + 间隔 N 周（1-52）+ 星期几集合；支持 2008 至 9999 年。
- 每场使用固定的本地开放/截止时间（分钟精度）；截止在开放当日或次日。
- 每条排期最多 64 个排除日期，仅取消当日原本会开启的场次。
- 冲突判定：取货点相同、共享至少一个 SKU 且销售窗口在真实时间上相交；
  窗口含开放瞬间、不含截止瞬间（首尾相接不冲突）。
- 时区固定 America/Chicago（UTC-6/UTC-5，3 月第二个周日与 11 月第一个周日切换）。
  开放/截止落入春季缺失时刻整场取消；秋季重复时刻开放取较早、截止取较晚真实瞬间。

## 构建与测试

```sh
npm install
npm test
```

只需 Node.js；`npm install` 安装唯一的开发依赖 typescript，
`npm test` 编译后运行全部单元测试、随机化逐场对照测试与规模/内存/耗时验证。

## 实现要点

- `src/date.ts`：公历日期与内部天数的换算（Howard Hinnant 算法）。
- `src/timezone.ts`：固定芝加哥规则的本地时刻 → 真实瞬间解析（含缺失/重复时刻处理）。
- `src/schedule.ts`：排期校验、编译与单场真实窗口计算。
- `src/conflict.ts`：两条排期的最早冲突。利用“场次不足两天、开放日相差至多一天”
  把星期组合归并为至多 3 个周同余类（CRT 求解），常规周用本地窗口 O(1) 判定，
  DST 过渡周单独精确计算，因此完整有效期（2008-9999）无需逐场枚举。
- `src/checker.ts`：对外 API，按取货点索引已发布排期。
