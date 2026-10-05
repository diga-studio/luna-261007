# secure-vault

进程内的限次流式查看闸门（TypeScript 库）。调用方提供可信的 `userId` 和按
`documentId` 打开异步字节流的内容源；权限状态只保存在内存中。

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js（>= 18）与 devDependencies 中的 TypeScript / @types/node。

## API

```ts
import { SecureVault, FileContentSource } from "secure-vault";

const vault = new SecureVault({
  source: new FileContentSource("/data/docs"), // 或任何 ContentSource
  clock: () => Date.now(),                      // 可选，注入时钟用于测试
});

vault.setGrant("user-1", "doc-42", { expiresAt: null, maxViews: 3 });
const token = vault.issueToken("user-1", "doc-42"); // 60 秒有效的签名令牌

for await (const chunk of vault.open("user-1", token)) {
  // chunk: Uint8Array，每块 ≤ 64 KiB
}
```

- `setGrant(userId, documentId, grant)`：`grant` 为 `null` 表示撤销；
  `expiresAt` / `maxViews` 为 `null` 表示该项不限。每次设置都产生新授权并
  重新计数，旧令牌与旧流立即失效。
- `issueToken(userId, documentId)`：授权有效且有剩余次数时签发；不扣次数。
- `open(userId, token)`：验证令牌签名与用户绑定，返回异步字节流；
  `open` 本身不扣次数。

## 核心语义

- 流第一次交付非空字节时，同步原子地确认当前授权、令牌期限与剩余次数，
  并只扣一次；同一令牌可打开多个流，每个流各自计一次。
- 每块交付前都重新检查撤销、重新授权与两个期限（授权 `expiresAt`、
  令牌 60 秒 TTL）；失效后挂起的 `next()` 与后续 `next()` 都拒绝，
  绝不交付已读出的缓冲块或以正常结束掩盖中断。
- 已扣次的流不因次数归零而中断；首块前的失败或取消不扣次，首块后不退款。
- 流为拉取式：同一时刻每个流最多缓冲一块（≤ 64 KiB），不整文件预读；
  权限变更是同步的，不等待任何内容源。

## 内容源

`ContentSource` 接口：`open(documentId): AsyncIterable<Uint8Array>`，
每块不超过 64 KiB。`FileContentSource` 是本地文件适配器（按 `rootDir`
下的相对路径读取，拒绝路径逃逸）。测试中的 `ControllableSource`
（`test/helpers.ts`）可暂停/释放读取，用于确定性的并发测试。
