# secure-vault

进程内的限次流式查看闸门（TypeScript 库）。调用方提供可信的 `userId` 与按
`documentId` 打开异步字节流的内容源；SecureVault 负责授权、令牌签发与限次交付。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试（node:test）
npm run build   # 仅编译到 dist/
```

## API

```ts
import { SecureVault, FileContentSource } from 'secure-vault';

const vault = new SecureVault({
  source: new FileContentSource(),   // 或任何实现了 ContentSource 的对象
  clock: () => Date.now(),           // 可注入时钟（可选）
  tokenTtlMs: 60_000,                // 令牌有效期（可选，默认 60s）
  secret: '...',                     // HMAC 密钥（可选，缺省随机生成）
});

// 设置 / 撤销授权（字段为 null 表示该项不限；grant 为 null 表示撤销）
vault.setGrant(userId, documentId, { expiresAt: Date.now() + 3600_000, maxViews: 3 });
vault.setGrant(userId, documentId, null); // 撤销

// 签发令牌（授权有效且尚有次数时；签发不扣次数）
const token = vault.issueToken(userId, documentId);

// 打开流（open 不扣次数；同一令牌可打开多个流，每个流的首块交付各计一次）
for await (const chunk of vault.open(userId, token)) {
  // chunk: Uint8Array，每块 ≤ 64 KiB
}
```

## 语义要点

- **计数点**：流第一次交付非空字节时，原子地校验当前授权、令牌期限与剩余次数，
  并只扣一次。`open` 与 `issueToken` 均不扣次数。
- **逐块校验**：每块交付前都重新校验撤销、重新授权与两个期限；失效后挂起中的
  `next()` 在放行时拒绝，后续 `next()` 也拒绝，绝不交付已读出的缓冲块。
- **重新授权**：每次 `setGrant` 产生全新授权并重新计数，旧令牌与旧流立即失效。
- **不退款**：首块交付后无论正常结束、读失败还是 `return()`，次数都不恢复；
  首块交付前的失败或取消不扣次数。
- **并发**：无全局锁；同一授权的多个流可同时等待内容源，首块交付点的
  「校验 + 扣次」在同一个同步代码块内完成，保证不超过 `maxViews`。
- **缓冲**：逐块拉取、不预读，每个流至多持有一个 64 KiB 块。

## 内容源

```ts
interface ContentSource {
  open(documentId: string): AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;
}
```

- `FileContentSource`：本地文件适配器，`documentId` 即文件路径，默认 64 KiB 块。
- 测试可使用 `test/helpers.ts` 中的 `PausableSource`（可暂停/放行的内容源）与
  `ManualClock`（手动时钟）做确定性的并发与期限边界验证。
