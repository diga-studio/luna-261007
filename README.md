# WireGuard 隧道生命周期组件

进程内的 WireGuard 隧道生命周期管理（TypeScript，无运行时依赖）。

## 运行

```sh
npm install
npm test
```

`npm test` 会先用 `tsc` 编译到 `dist/`，再用 Node 内置测试运行器执行 `dist/test/*.test.js`。

## 结构

- `src/types.ts` — `Peer`、`Driver`、`DeviceInfo`、`OpenResult` 类型定义。
- `src/tunnel-manager.ts` — `TunnelManager`，提供 `open` / `close` / `block`。
- `test/test-driver.ts` — 可手动控制完成时刻的测试驱动，维护真实 peer 集合。
- `test/tunnel-manager.test.ts` — 场景测试。

## 关键语义

- 安装中、活跃、撤销中、删除失败的隧道都占用地址与用户名额（每用户最多 3 个）。
- 地址与用户名额只在 `remove` 成功（或 `install` 失败、peer 从未产生）后释放。
- `close` 可撤销安装中的隧道：对应 `open` 必然失败；若安装随后成功，会补发 `remove`，
  保证 peer 不会被安装复活。重复 `close` 安全。
- `block` 调用即标记 blocked（不可回滚），新 `open` 不再触碰驱动；
  仅当该设备全部隧道完成清理后才成功返回，清理失败可重试。
