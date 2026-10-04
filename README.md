# NomadPay 滚动限额转账内核

进程内 TypeScript 库。每个用户一个钱包，另有公共 `treasury`，支持 BTC、ETH、USDT、SOL、XRP。

## 使用

```ts
import { NomadPayKernel } from 'nomadpay-kernel';

const kernel = new NomadPayKernel({
  initialBalances: { alice: { BTC: '1.00000000' }, bob: {} },
  rates: { BTC: '20000.00000000', ETH: '3000.00000000', USDT: '1.00000000', SOL: '100.00000000', XRP: '0.50000000' },
  clock: { now: () => Date.now() },        // 只前进的毫秒时钟
  beforeCommit: async () => { /* 提交前暂停点 */ },
});

const result = await kernel.transfer('alice', 'bob', 'BTC', '0.10000000', 'unique-key');
kernel.setRates({ ... });                  // 原子替换整张汇率表
const view = kernel.inspect('alice');      // 各币余额 + 滚动额度用量
```

## 语义

- **转账**：成功时同步扣发送方本金+手续费、加收款方本金、加 treasury 手续费，记录结果并占用额度；拒绝不改变任何金融状态。
- **手续费**：本金的 0.1%，向上取整到 1e-8，且不低于 0.00010000。手续费不占额度。
- **滚动限额**：提交时刻 t 往前 24 小时内（`t-24h, t]`，恰好 24h 前的不计入）的成功转账，USDT 估值之和不得超过 25000。估值 = 提交时本金 × 当时汇率，精确乘积（1e-16 精度）永久固定，后续调汇率不重估历史。
- **幂等**：`key` 按发送者隔离，永久绑定收款人/币种/金额。同载荷重试返回首次结果（含拒绝）；不同载荷返回 `conflict`。重试不重新计费、不占额、不依据新汇率改写。
- **beforeCommit**：每个新 key 首次预检通过后、金融状态变化前 await 一次。恢复后按真正提交时的余额、汇率和滚动窗口重新判断。

金额与汇率为 8 位小数十进制字符串；估值以 16 位小数字符串返回。

## 构建与测试

```sh
npm install
npm test        # tsc 编译 + node --test
```
