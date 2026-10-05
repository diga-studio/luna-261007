# task26100752

DDoS 防护规则裁决库（TypeScript）。由上层流量分析模块在进程内直接调用：
规则与流量记录全部保存在内存中，库只返回处置决定，不执行真实流量处置。

## 使用

```ts
import { RuleEngine } from './src/index.ts';

const engine = new RuleEngine();

// 整体替换活动规则集合
engine.replaceRules([
  { id: 1, priority: 10, cidr: '0.0.0.0/0', protocol: 'ANY', port: 'ANY', action: 'RATE_LIMIT' },
  { id: 2, priority: 20, cidr: '10.0.0.0/8', protocol: 'TCP', port: { start: 80, end: 443 }, action: 'DROP' },
]);

// 对一批流量逐条裁决，输出顺序与输入一致
const verdicts = engine.judge([
  { sourceIp: '10.1.2.3', protocol: 'TCP', destinationPort: 80 },
  { sourceIp: '10.1.2.3', protocol: 'ICMP' }, // ICMP 无端口
]);
// => [{ ruleId: 1, action: 'RATE_LIMIT' }, { ruleId: 1, action: 'RATE_LIMIT' }]
```

## 裁决语义

- 规则字段：`id`（唯一整数）、`priority`（1..1000，数字小者优先）、`cidr`（/0../32，
  主机位不影响网络范围）、`protocol`（`TCP`/`UDP`/`ICMP`/`ANY`）、
  `port`（0..65535 闭区间或 `ANY`）、`action`（`ALLOW`/`RATE_LIMIT`/`CHALLENGE`/`DROP`）。
- 多条规则匹配时，优先级数字最小者获胜；并列时编号最小者获胜。
  网段具体程度与端口区间宽窄不影响胜负。
- ICMP 记录没有端口，只能命中端口条件为 `ANY` 的规则；
  其他记录必须同时满足网段、协议、端口三个条件。
- 无匹配规则时返回 `{ ruleId: null, action: 'ALLOW' }`。
- `replaceRules` 整体替换规则集合，后续批次只使用新集合。

## 实现要点

- 把规则集合的网段边界与端口边界分别离散化为基本区间（各 ≤ 2×规则数+1）。
- 查询时先二分定位 IP 基本区间，再查该区间在对应协议下的
  “端口段 → 获胜规则”行；行按懒加载计算并缓存，替换规则时全部失效。
- 行计算按（优先级、编号）顺序扫描覆盖该区间的规则，
  用并查集跳过已填充的端口段，每个端口段只写一次。
- ICMP 无端口维度，按 IP 区间在装载时直接预算获胜者。
- 内存上界：TCP/UDP 行缓存合计 ≤ 2 × 4001 × 4001 × 2 字节 ≈ 61 MiB，远低于 128 MiB 限制。

## 构建与测试

只需要 Node.js（≥ 22.18，利用原生类型擦除直接运行 TS 测试）：

```sh
npm install
npm test
```

测试覆盖：/0 与 /32 交叠按优先级而非具体程度裁决、同优先级编号决胜、
端口闭区间端点与 ICMP 无端口、删改遮挡规则后被遮挡规则重新获胜、
以及满载性能（2000 规则 × 1000 批 × 10000 条，末位命中与无匹配混合）。

本机实测：规则装载约 14ms（限 2s），1000 批总裁决约 6.1s（限 15s），
库持有数据内存增长约 11 MiB（限 128 MiB）。
