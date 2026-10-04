# random-walk-signal

可随机访问、可分片生成的高斯随机游走信号库（TypeScript）。

- 固定 1ms 采样，合法索引 `0..M`，`M = 7 776 000 000`（90 天）。
- 轨迹由 64 位整数 `seed`、字符串 `streamId`、`initial`、正数 `sigma` 确定。
- `valueAt(index)`：O(log M) 单点查询，无需先读任何点。
- `readRange(start, count)`：惰性迭代器，消费 k 点总工作量 O(k + log M)，
  每个迭代器 O(log M) 空间，提前停止即不再产生工作。
- 同一运行时内，相同参数与索引的结果逐位确定，与读取顺序、分片方式、
  实例重建、其他设备是否参与无关。

设计原理见 [DESIGN.md](DESIGN.md)。

## 使用

```ts
import { createWalk, M } from 'random-walk-signal';

const walk = createWalk(42n, 'device/alpha', 0, 1.5);
walk.valueAt(123_456_789);            // 任意点直查
for (const x of walk.readRange(0, 1000)) { /* 惰性顺序消费 */ }
```

## 构建与测试

要求 Node.js ≥ 24（测试文件由 Node 原生类型擦除直接运行）。

```
npm install
npm test        # tsc 构建 + node --test（一致性 / 统计 / 复杂度共 21 项）
npm run build   # 仅编译到 dist/
```
