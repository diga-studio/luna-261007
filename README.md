# task26100749

VaultPay 失败率告警计算库（进程内计算，TypeScript 实现）。

## 语义

- 在时刻 `t`，某终端的窗口包含 `timestamp <= t` 且 `timestamp` 严格大于
  `t - 24h` 的交易；失败率 = `failed` 条数 / 窗口内全部条数。
- 失败率**严格**大于 5% 时告警；空窗口与恰好 5% 均不告警（内部用整数
  比较 `failed * 20 > total`，无浮点误差）。
- 交易在进入（`timestamp`）和退出（`timestamp + 24h`）窗口时都可能改变
  告警状态；同一毫秒的全部变化原子生效，不产生零长度告警或中间状态。
- 告警边界是状态首次翻转的时刻（交易进入/退出时刻），与调用
  `advanceWatermark` 的时机和步长无关。

## 接口

- `new AlertEngine(initialWatermark)`：以初始时间水位创建引擎。
- `ingest(records)`：批量接收交易。水位之后的交易允许乱序到达，暂不影响
  当前窗口；同一 `transaction_id` 的重复投递不重复计数；`timestamp` 不晚于
  当前水位的记录视为迟到的过期数据，直接忽略（水位语义：水位之前的数据
  已完整）。
- `advanceWatermark(t)`：单调推进水位，返回上次水位之后、本次水位以内的
  全部告警开始/结束变化（`AlertChange[]`）；未结束的区间只返回开始变化。
  水位回退会抛错。

对同一组已接受交易，在相同初始水位与最终水位下，输入排列与推进步长不会
改变拼接后的告警序列。

## 构建与测试

```sh
npm install
npm test
```
