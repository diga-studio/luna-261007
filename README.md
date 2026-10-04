# random-walk-signal

可随机访问、可分片生成的高斯随机游走信号库（TypeScript）。

- 固定 1ms 采样，合法索引 `0..M`，`M = 7,776,000,000`（90 天）。
- 轨迹由 64 位 `seed`、字符串 `streamId`、`initial`、`sigma > 0` 确定。
- `valueAt(index)`：O(log M) 单点随机访问，无需顺序扫描。
- `readRange(start, count)`：惰性迭代器，O(k + log M) 总量，O(log M) 空间。
- 同一运行时内，相同参数与索引的结果逐位相等，与读取顺序、分片方式、
  实例重建无关。

```ts
import { createWalk } from "./src";

const walk = createWalk(12345n, "device-7", 0, 1.5);
walk.valueAt(4_000_000_000);        // 任意点直接查询
for (const v of walk.readRange(0, 1000)) { /* 惰性顺序消费 */ }
```

## 构建与测试

```sh
npm install
npm test
```

只依赖 Node.js（>= 18）与 devDependency `typescript`。

设计与正确性论证见 [DESIGN.md](DESIGN.md)。
