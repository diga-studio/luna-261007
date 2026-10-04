# NomadPay 滚动限额转账内核

进程内 TypeScript 库：每用户一个钱包 + 公共 treasury，支持 BTC / ETH / USDT / SOL / XRP。

## 构建与测试

```sh
npm install
npm test        # = tsc 构建 + node --test
```

只依赖 Node.js（>=22，测试脚本用到 node --test 的 glob 支持）与 devDependencies 中的 typescript，无数据库、无网络服务、无监听端口。

## API

```ts
import { NomadPayKernel } from './src/index.js';

const kernel = new NomadPayKernel({
  initialBalances: { alice: { USDT: '1000' } },   // 初始余额，不占发送额度
  rates: { BTC: '20000', ETH: '3000', USDT: '1', SOL: '150', XRP: '0.5' },
  clock: { now: () => Date.now() },               // 只前进的毫秒时钟
  beforeCommit: async () => {},                   // 每个新 key 预检通过后 await 一次
});

await kernel.transfer('alice', 'bob', 'USDT', '10.5', 'idem-key-1');
kernel.setRates({ BTC: '21000', ETH: '3000', USDT: '1', SOL: '150', XRP: '0.5' }); // 整表原子替换
kernel.inspect('alice'); // { balances, rollingLimitUsedUsdt, rollingLimitCapUsdt }
```

## 核心规则

- **原子转账**：成功 = 扣发送方（本金+手续费）、记收款方本金、记 treasury 手续费、占用额度，四者同时发生；拒绝不改变任何金融状态。
- **手续费**：本金的 0.1%，向上取整到最小代币单位（10^-8），且不低于 0.00010000；手续费不占额度。
- **滚动限额**：提交时刻 t，发送者提交时间落在 (t-24h, t] 的成功转账（含本次）USDT 估值之和 ≤ 25000。估值 = 提交时本金 × 当时汇率的精确乘积（BigInt，10^16 缩放，不舍入），永久固定；恰好 24 小时前的转账不再占额。
- **幂等键**：按发送者隔离，永久绑定收款人+币种+金额。同载荷重试返回首次完成的结果（含拒绝），不重复计费/占额/调钩子；不同载荷返回 `KEY_CONFLICT`。
- **beforeCommit**：新 key 预检通过后、金融状态变化前 await 一次；恢复后按真正提交时的余额、汇率、滚动窗口重新判断，预检不构成授权。
- 金额与汇率为至多 8 位小数的十进制字符串，内部以 BigInt 定点数运算，无浮点误差。

## 布局

- `src/decimal.ts` — 8 位小数十进制定点数（解析/格式化/手续费/精确乘积）
- `src/kernel.ts` — 转账内核（余额账本、滚动窗口、幂等键、提交两阶段）
- `src/types.ts` — 公共类型
- `test/` — node:test 可重复测试（手动时钟 + 可暂停钩子）
