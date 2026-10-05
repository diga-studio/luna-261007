# dual-track-review

贷款双轨保护核查库：判定止赎推进是否发生在完整减损申请待处理期间。
由上层业务系统直接调用，数据持久化到 SQLite（Node 内置 `node:sqlite`，无原生依赖）。

## 要求

- Node.js >= 22.5（`node:sqlite` 内置模块）

## 构建与测试

```sh
npm install
npm test        # 编译 src + test 并运行全部测试
npm run build   # 仅编译库到 dist/
```

## 使用

```ts
import { DualTrackReview } from "dual-track-review";

const lib = new DualTrackReview("review.db"); // ":memory:" 可纯内存运行

// 批量登记 / 更正 / 作废（同一接口，以 revision 区分版本，voided 表示作废）
lib.submitApplications([
  { id: "A1", loanId: "L1", revision: 1, completeAt: t0, terminatedAt: null, voided: false },
]);
lib.submitAdvancements([
  { id: "F1", loanId: "L1", revision: 1, occurredAt: t1, voided: false },
]);

const verdict = lib.checkAdvancement("F1");
// { advancementId, active, violation, protectedBy }
```

## 语义

- 保护区间为 `[completeAt, terminatedAt)`：含资料齐全时刻，不含终止时刻；
  `terminatedAt` 为 `null` 表示仍在待处理。尚未齐全的申请不产生保护。
- 推进只与同一贷款的申请比较；被至少一份申请保护即违规，一条推进只计一条违规。
- 每个编号只采用最高修订号；相同或更低修订号的投递被忽略；
  作废（`voided: true`）同样占用修订号，迟到的旧版本不能复活记录。
- 判定始终基于当前有效记录独立核算，与记录进入系统的先后顺序无关；
  更正业务时刻会补出历史违规或撤除已不成立的违规。
