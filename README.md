# dual-track-review

贷款双轨保护核查库（TypeScript + SQLite）。判定每次止赎推进是否发生在完整减损申请待处理期间，由上层业务系统直接调用。

## 运行要求

- Node.js >= 24（使用内置 `node:sqlite`，无任何原生/外部服务依赖）
- `npm install` 后 `npm test` 即可运行全部测试

## 核心语义

- **保护区间**：`[completeAt, terminatedAt)` —— 包含资料齐全时刻，不包含终止时刻；`terminatedAt` 为 `null` 表示仍在待处理。试行计划不终止保护。
- **业务时刻**：Unix 毫秒时间戳，精确到毫秒。
- **违规判定**：推进时刻被同一贷款的至少一份当前有效申请保护即违规；一条推进只计一条违规。
- **版本规则**：每个编号只采用最高修订号；较旧或相同版本的重复投递不改变结果；作废同样占用修订号，迟到的旧版本不能复活记录。贷款归属固定。
- **判定时效**：判定在查询时依据当前掌握的全部业务事实独立核算，与记录进入系统的先后顺序无关；迟到更正会补出历史违规，作废会撤除已不成立的违规。

## API

```ts
import { DualTrackReview } from "dual-track-review";

const review = new DualTrackReview("review.sqlite"); // 或 ":memory:"

// 批量登记 / 更正 / 作废（同一事务生效）
review.submit([
  { kind: "upsert-application", applicationId: "A1", revision: 1, loanId: "L1",
    facts: { completeAt: 1767225600000, terminatedAt: null } },
  { kind: "upsert-advancement", advancementId: "F1", revision: 1, loanId: "L1",
    facts: { occurredAt: 1767312000000 } },
  // { kind: "void-application", applicationId: "A1", revision: 2 }
  // { kind: "void-advancement", advancementId: "F1", revision: 2 }
]);

// 查询任意一条推进的判定
const d = review.determineAdvancement("F1");
// { advancementId, active, violation, protectingApplicationIds }

// 查询一笔贷款当前全部推进的判定
const all = review.determineLoan("L1");

review.close();
```

## 项目结构

- `src/types.ts` —— 命令与判定结果的类型定义
- `src/store.ts` —— SQLite 持久化：保存全部修订版本，提供当前有效记录视图
- `src/engine.ts` —— 纯判定逻辑（保护区间与违规核算）
- `src/index.ts` —— 对外入口 `DualTrackReview`
- `test/review.test.ts` —— 自动化测试，含与独立核算参考实现的一致性对账
