# vpn-failover

主备 VPN 隧道切换库（TypeScript）。由上层控制面调用，配置与运行状态只保存在进程内，不涉及真实 VPN 通信。

## 能力

- 最多管理 250 组互联，每组固定主、备两条候选隧道，各组独立选择转发路径。
- 接收上层按隧道顺序（先主后备）排列好的探测结果：一次成功即判定可用并清零连续超时；连续 3 次超时判定不可用，前两次不改变可用状态。
- 目标始终是可用隧道中优先级最高者（主用优先），都不可用时目标为空；查询同时展示目标与活动会话。
- 会话准备/释放由调用方回调完成。目标改变作废旧准备，晚到的准备结果永不夺回转发权，只能被释放；被撤销/替换的会话恰好释放一次。
- 所有状态变化与释放同步完成；准备悬置不阻塞新探测结果与查询。

## 使用

```ts
import { VpnFailoverManager, ProbeOutcome, TunnelRole } from "./src";

const mgr = new VpnFailoverManager(
  {
    prepare: (groupId, tunnel) => myPrepare(groupId, tunnel), // Promise<会话句柄>
    release: (groupId, tunnel, session) => myRelease(session), // 同步、不失败
  },
  ["site-a", "site-b"], // 组 ID 列表，最多 250 个
);

// 每 30 秒一轮，按 [主用, 备用] 顺序上报
mgr.applyProbeResults("site-a", [ProbeOutcome.Success, ProbeOutcome.Timeout]);

const status = mgr.getGroupStatus("site-a");
// { target, activeTunnel, activeSession, primaryUp, backupUp, preparePending }
const all = mgr.getAllGroupStatus();
```

## 构建与测试

```sh
npm install
npm test   # 先 tsc 构建，再用 node:test 运行全部测试
```
