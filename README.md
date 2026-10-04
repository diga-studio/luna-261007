# deploy-failure-alerts

部署失败告警组件，供终端管理平台直接调用。输入部署尝试的结果上报，输出当前应存在的连续失败告警区间。

## 用法

```ts
import { AlertTracker } from "./src/alert-tracker";

const tracker = new AlertTracker();
const { added, removed } = tracker.apply({
  deviceId: "dev-1",
  applicationId: "app-1",
  seq: 7,
  revision: 2,
  outcome: "Failed", // 或 "Installed"
});
const alerts = tracker.listAlerts({ deviceId: "dev-1", applicationId: "app-1" });
```

## 语义

- 流由 `(deviceId, applicationId)` 标识，彼此独立；流内每次尝试有正整数 `seq`。
- 同一 `seq` 以最高 `revision` 为准；较低版本与重复版本被忽略，更高版本可任意校正（成功↔失败）。
- 告警是极大的连续失败区间且长度 ≥ 6；区间内每个整数序号都必须已知且失败，成功或未知序号都会截断区间，不跨缺口合并。
- `apply` 返回本次调用新增/移除的告警区间；区间端点变化算删除旧区间 + 增加新区间；状态未变（重复、过期、仅提 revision）返回空差分。
- 每次上报后，告警集合恰好等于对该流全部有效结果的全量重算结果。

## 复杂度

设某流已有 `n` 条有效结果、当前告警数为 `k`：

- `apply`：`O(n log n)`（对该流全部有效结果排序后单趟扫描重算告警，差分比较 `O(k)`）。状态未变的上报提前返回，`O(1)`。
- `listAlerts`：`O(k)`（返回当前告警列表的副本）。
- 空间：`O(n)`，每流保存每个 `seq` 的最高 revision 有效结果。

## 构建与测试

只需 Node.js（≥ 21）：

```sh
npm install
npm test
```
