# task26100727

进程内 WireGuard 隧道生命周期组件（TypeScript，纯内存状态）。

## 结构

- `src/types.ts` — `Peer` / `Driver` / `ApprovedDevice` / `OpenResult` 类型定义。
- `src/tunnel-manager.ts` — `TunnelManager`：构造时接收互异 IPv4 地址列表、已获批设备（含所属用户）与可注入驱动；提供 `open(deviceId)` / `close(tunnelId)` / `block(deviceId)`。
- `test/manual-driver.ts` — 测试驱动：手动控制 `install`/`remove` 的完成时刻，并维护实际 peer 集合。
- `test/tunnel-manager.test.ts` — 基于 `node:test` 的自动化测试。

## 语义要点

- 地址与用户名额（每用户最多 3 条）在隧道整个生命周期内被占用：安装中、活跃、撤销中、删除失败都计入；
  只有清理成功（`remove` 生效，或 `install` 失败从未生效）后才释放。
- `tunnelId` 生命周期内唯一且永不复用。
- `close` 可撤销安装中的隧道：对应 `open` 必然失败，安装若随后生效会被立即 `remove`，不会复活；
  已关闭/不存在的隧道重复 `close` 直接成功。
- `remove` 失败时 `close`/`block` 报告失败，资源继续占用，重复调用可继续清理。
- `block` 调用即生效且不可回滚：之后该设备的新 `open` 不再触达驱动；
  仅当该设备全部隧道满足 `close` 成功条件后才成功返回。

## 构建与测试

```sh
npm install
npm test
```

仅需 Node.js；`npm test` 会先用 `tsc` 编译到 `dist/`，再以 `node --test` 运行测试。
