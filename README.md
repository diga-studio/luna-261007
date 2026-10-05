# workforge-payroll

WorkForge 多费率加班核算库：单客户、周薪或双周薪，TypeScript 实现，无运行时依赖。

## 使用

```ts
import { calculatePayRun } from "./src/index.js";

const result = calculatePayRun(
  "2026-10-05", // periodStart：周一零点所在的日期（YYYY-MM-DD）
  2,            // weeks：1 或 2
  shifts,       // ShiftRecord[]：员工、工地、工种、起止时间、基础时薪（分）、班次差异（基点）
  rules,        // PayRules：各工地/工种最低时薪、是否启用日加班
);
// result.lines：按 员工×工作周×工地×工种 唯一的账行
// result.totals：员工本期合计（直接相加已核算的周金额）
```

## 核算口径

- 工作周固定为周一零点起 7 天，自然日固定为午夜起 24 小时；阈值按员工累计。
- 有效时薪 = max(基础时薪, 最低时薪) × (1 + 班次差异基点/10000)；所有分钟（含加班）都先获得基础工资。
- 日加班：每日超过 480 分钟的部分；周加班：非日加班分钟每周超过 2400 分钟的部分。
- 加班增额：每个加班分钟另获该员工该周常规时薪（周基础工资/周总工时）的 0.5 倍。
- 金额用 BigInt 有理数精确计算；员工每周的基础工资、加班增额分别半分向上舍入到整数分，
  再按最大余数法分摊到各账行（并列时按工地、工种字典序），保证账行之和等于周总额，
  且每行与未舍入值之差小于 1 分。结果与输入顺序、记录拆分无关。

## 构建与测试

```sh
npm install
npm test        # 编译 TypeScript 并运行 node:test 测试
```
