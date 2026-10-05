# VaultPay 失败率告警引擎

进程内计算的终端交易失败率告警库（TypeScript）。

## 语义

- 时刻 `t` 的窗口：`(t - 24h, t]`，即 `timestamp <= t` 且 `timestamp > t - 24h` 的交易。
- 失败率 = `status === "failed"` 的条数 / 窗口内全部条数；**严格**大于 5% 才算超阈（恰好 5% 与空窗口均不超阈）。
- 交易进入窗口（到达其 `timestamp`）与退出窗口（`timestamp + 24h`）都可能翻转告警状态；
  同一毫秒的全部变化作为一个整体生效，不产生零长度告警、不暴露中间状态。
- 开始时刻 = 首次超阈的边界，结束时刻 = 首次不再超阈的边界，与调用 `advanceWatermark` 的时机无关。

## API

```ts
import { VaultPayAlertEngine } from "./src";

const engine = new VaultPayAlertEngine(initialWatermark);
engine.ingest(records);            // 批量交易；同 transaction_id 去重；水位之后的交易暂存
const changes = engine.advanceWatermark(t); // 单调推进；返回 (上次水位, t] 内的 start/end 变化
```

- `ingest`：允许乱序与重复投递；同一 `transaction_id` 只计一次；水位之后的交易不影响当前窗口。
- `advanceWatermark`：水位只能单调前进（回退抛错，原地返回空）。未结束的区间只返回 `start`，
  其 `end` 会在后续推进、区间真正结束时返回。结果按 `(时刻, 终端)` 排序。
- 对同一组已接受交易，相同初始水位与最终水位下，输入排列与推进步长不影响拼接后的告警序列。
- 引擎创建时若水位上已处于超阈状态，该区间开始时刻不晚于初始水位，故只会在其结束时发出 `end`。

## 构建与测试

仅需 Node.js（>= 18）：

```sh
npm install
npm test
```

`npm test` 先用 `tsc` 编译到 `dist/`，再用 Node 内置 test runner 运行 `dist/tests/**/*.test.js`。
不依赖 Docker、数据库或任何常驻服务。
