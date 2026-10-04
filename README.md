# vpn-failover

主备 VPN 隧道切换库（TypeScript）。由上层控制面调用，配置与运行状态只保存在进程内。
库负责接收探测结果、协调会话准备，并提供各组目标隧道与活动会话的查询能力；
不执行探测，也不涉及真实 VPN 通信。

## 构建与测试

本库最多管理 250 组互联，每组固定包含主、备两条候选隧道。

```sh
npm install
npm test        # 编译 + 运行全部测试（仅需 Node.js，无其他服务）
npm run build   # 仅编译到 dist/
```

## 使用

```ts
import { FailoverManager } from 'vpn-failover';

const manager = new FailoverManager({
  // 异步准备会话：可立即成功、任意延后或永不完成；不会失败
  prepare: (groupId, tunnel) => myVpnClient.openSession(groupId, tunnel),
  // 同步释放会话：不会失败
  release: (session) => myVpnClient.closeSession(session),
});

manager.addGroup('site-a');                    // 最多 250 组
manager.reportProbeResults('site-a', [         // 每 30 秒一轮，已按隧道排序去重
  { tunnel: 'primary', outcome: 'success' },
  { tunnel: 'backup', outcome: 'timeout' },
]);

const status = manager.getGroupStatus('site-a');
// { target, activeTunnel, activeSession, primaryAvailable, backupAvailable, preparingTunnel }
const all = manager.getAllStatus();            // 一次查询全部组
```

## 行为规则

- 一次成功探测即判定隧道可用并清零连续超时；连续 3 次超时才判定不可用。
- 目标是当前可用隧道中优先级最高者（主优先），都不可用则为 `null`；
  目标与活动会话可能暂时不同，查询同时展示二者。
- 每组至多一个活动会话，其所属隧道必须可用；活动隧道失效立即撤销并释放。
- 旧活动隧道仍可用时，在新目标准备成功前继续使用旧会话；
  活动会话已属于目标时不重新准备。
- 每次目标改变，之前在途的准备永久失效；失效准备完成后只释放所得会话，
  绝不获得转发权。被撤销/替换的会话恰好释放一次。
