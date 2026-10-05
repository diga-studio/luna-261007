# 合同履约计分库

TypeScript 实现的合同履约计分库，由上层系统直接调用；规则与处理结果持久化在 SQLite（使用 Node.js 内置 `node:sqlite`，无原生依赖）。

## 构建与测试

要求 Node.js ≥ 23.4（内置 `node:sqlite` 免标记可用，推荐 24 LTS）。

```sh
npm install
npm test
```

测试覆盖：月末/闰年锚点恢复、区间部分截取周期、按时改逾期、免除后撤销、舍入到 70 但实际低于 70 的风险判定、小规模汇总与逐期独立核算对拍，以及 1 万合同 / 10 万规则 / 20 万处理结果 / 50 年跨度的规模用例（报告查询耗时、内存增量与持久化大小，并验证更正后汇总立即变化）。

## API

```ts
import { openDatabase, Scorecard } from 'contract-performance-score';

const sc = new Scorecard(openDatabase('data.db'));

// 登记规则（登记后不可修改）：once | monthly | quarterly | yearly
const ruleId = sc.registerRule({
  contractId: 'C001',
  firstDueDate: '2024-01-31',
  endDate: '2026-12-31',
  frequency: 'monthly',
});

// 登记某一期的处理结果（重复登记替换旧结果）
sc.recordOutcome(ruleId, '2024-02-29', { kind: 'completed', completedDate: '2024-02-28' });
sc.recordOutcome(ruleId, '2024-03-31', { kind: 'waived' });

// 撤销为未处理
sc.revokeOutcome(ruleId, '2024-03-31');

// 查询区间履约汇总（按到期日归属，两端包含）
const summaries = sc.summarize('2024-01-01', '2024-12-31');
// => [{ contractId, numerator, denominator, score, atRisk }, ...]

sc.close();
```

## 计分规则

- 周期以首个到期日为锚点：每月/每季/每年相隔 1/3/12 个月；目标月没有锚点日号时取该月最后一天，后续仍用原始锚点（如 `2024-01-31` → `2024-02-29` → `2024-03-31`）。
- 分母 = 区间内应到期期次 − 免除期次；未处理与逾期完成留在分母。分子 = 按时完成（完成日期 ≤ 到期日）期次。
- 分数 = 分子 / 分母 × 100，四舍五入保留两位小数；分母为 0 记 100 分。
- 风险状态按未舍入比例判断是否低于 70 分（整数比较，无浮点误差）。
- 历史区间使用最新处理结果实时重算，更正立即生效。
