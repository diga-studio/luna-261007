# contract-compliance-scorer

合同履约计分库。由上层系统直接调用，规则与处理结果持久化在 SQLite（Node.js 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.5（推荐 24）；仅开发依赖 TypeScript 与 @types/node。

## 使用

```ts
import { ComplianceScorer } from 'contract-compliance-scorer';

const scorer = new ComplianceScorer('data/compliance.db');

// 登记履约规则（登记后不可修改）；frequency: once | monthly | quarterly | yearly
const ruleId = scorer.registerRule({
  contractId: 'CT-001',
  firstDueDate: '2024-01-31', // 首个到期日（UTC 自然日，YYYY-MM-DD）
  endDate: '2026-12-31',      // 履约终止日，之后不再产生期次
  frequency: 'monthly',
});

// 登记某一期的处理结果（重复登记替换旧结果；提前完成允许）
scorer.recordCompletion(ruleId, '2024-02-29', '2024-02-28'); // 完成日期 <= 到期日才算按时
scorer.recordExemption(ruleId, '2024-03-31');                // 免除：不计入分母
scorer.revokeResult(ruleId, '2024-03-31');                   // 撤销，恢复为未处理

// 批量导入可用事务包裹，任一失败整体回滚
scorer.transaction(() => {
  scorer.recordCompletion(ruleId, '2024-04-30', '2024-04-30');
});

// 查询指定区间（含两端）所有合同的履约汇总；历史查询使用最新处理结果
const summaries = scorer.summarize('2024-01-01', '2024-12-31');
// => [{ contractId, numerator, denominator, score, atRisk }, ...]

scorer.close();
```

## 计分口径

- 期次按锚点生成：每月/每季/每年相隔 1/3/12 个月；目标月没有锚点日号时取该月最后一天，后续仍用原始锚点（如 `2024-01-31` → `2024-02-29` → `2024-03-31`）。
- 查询按到期日归属区间，两端均包含；未来到期的期次即使提前完成也不计入此前区间。
- 分母 = 区间内应到期期次 − 免除期次（未处理与逾期完成均留在分母）；分子 = 其中按时完成的期次。
- 分数 = 分子/分母 × 100，四舍五入保留两位小数；分母为 0 记 100 分。
- 风险状态按**未舍入**比例判断是否低于 70 分（展示分舍入到 70 但实际不足 70% 仍为风险）。

## 构建与测试

```sh
npm install
npm test        # tsc 构建 + node:test 全量测试（含规模用例）
npm run build   # 仅构建到 dist/
```

规模用例覆盖 1 万合同 / 10 万规则 / 20 万处理结果 / 50 年跨度，断言并报告：预热后全区间查询 < 2s、相对空库进程内存增量 < 96 MiB、持久化体积 < 150 MiB，且更正处理结果后相同区间立即得到新结果。
