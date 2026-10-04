# deploy-failure-alerts

部署失败告警组件（TypeScript），供终端管理平台直接调用。输入为部署尝试的结果上报，输出为当前应存在的连续失败告警区间。终端可乱序、补报或以更高 revision 校正任意历史结果，告警集合随之精确修订。

## 规则

- 流由 `deviceId` + `applicationId` 共同标识，彼此独立。
- 流内每次部署尝试按派发顺序获得正整数 `seq`；重试是新的 `seq`。
- 同一 `seq` 以最高 `revision` 为准：更低版本忽略，相同版本幂等。
- 未收到结果的序号视为未知；成功或未知都会截断连续失败区间。
- 告警 = 极大的连续失败区间，且长度 ≥ 6；多个互不相连的区间并存。

## API

```ts
import { AlertTracker } from "./src/index.js";

const tracker = new AlertTracker();

// 接受一条上报，返回本次调用新增/移除的告警区间
const diff = tracker.apply({
  deviceId: "dev-1",
  applicationId: "app-1",
  seq: 7,
  revision: 2,
  outcome: "Failed", // 或 "Installed"
});
// diff: { added: AlertInterval[], removed: AlertInterval[] }

// 查询某条流当前全部告警区间
const alerts = tracker.listAlerts({ deviceId: "dev-1", applicationId: "app-1" });
// alerts: [{ start: number, end: number }]（闭区间，按 start 升序）
```

差分语义：区间端点变化 = 删除旧区间 + 新增新区间；完全不变的区间不出现在差分中；重复、过期、以及只提高 revision 不改变有效状态的上报均返回空差分。

## 复杂度

设某条流当前已知结果数为 `k`，告警区间数为 `a`：

- `apply`：`O(k)`。二分定位插入点 `O(log k)`，有序数组插入 `O(k)`，随后对该流全部有效结果做一次线性扫描重算告警 `O(k)`，差分比较 `O(a²)`（`a` 通常远小于 `k`）。内存 `O(k)`。
- `listAlerts`：`O(a)`，直接返回缓存的当前告警集合副本。

选择"每次全量重算该流告警"而非增量维护区间边界，是为了在任意久远历史都可被修订的语义下保证正确性：任何一次上报生效后，当前告警集合恰好等于按全部有效结果重新计算的结果。

## 构建与测试

只需 Node.js（≥ 18）：

```sh
npm install
npm test
```

测试包含：

- `test/alertTracker.test.ts`：确定性场景——乱序形成 1..13 失败区间、把 7 校正为成功拆成两个长度 6 的告警、旧版本/重复版本/仅升 revision 均返回空差分、更高版本恢复失败合并回 `[1,13]`、缺失序号不能跨缺口合并、多区间并存与截断。
- `test/randomized.test.ts`：固定随机种子（mulberry32, seed=20261007）生成多流、乱序、过期/重复/修订混合的 2000 步序列，每步与测试内独立的全量重算模型核对差分与当前告警集合。
