# ddos-rule-adjudicator

进程内 DDoS 防护规则裁决库（TypeScript）。由上层流量分析模块调用，只返回处置决定，不执行真实流量处置。规则与索引全部驻留内存，无外部服务依赖。

## 使用

```ts
import { AdjudicationEngine } from './src';

const engine = new AdjudicationEngine();

// 整体替换活动规则集合；后续批次只使用新集合
engine.replaceRules([
  {
    id: 1,                       // 唯一整数编号
    priority: 10,                // 1..1000，数字小者优先；同级编号小者优先
    cidr: '10.0.0.0/8',          // 源 IPv4 网段，/0../32，主机位被掩掉
    protocol: 'TCP',             // TCP | UDP | ICMP | ANY
    port: { kind: 'range', from: 80, to: 443 }, // 闭区间；或 { kind: 'any' }
    action: 'drop',              // allow | rate-limit | challenge | drop
  },
]);

// 批量裁决，输出顺序与输入一致
const decisions = engine.adjudicate([
  { srcIp: '10.1.2.3', protocol: 'TCP', dstPort: 80 },
  { srcIp: '10.1.2.3', protocol: 'ICMP' }, // ICMP 无端口
]);
// => [{ action: 'drop', ruleId: 1 }, ...]
// 无匹配时：{ action: 'allow', ruleId: null }
```

## 裁决语义

- 匹配条件：源地址落在规则网段内 + 协议条件满足（`ANY` 匹配所有协议）+ 端口条件满足。
- ICMP 记录没有端口，只能命中端口条件为 `any` 的规则；其他记录必须同时满足网段、协议、端口三个条件。
- 多条规则匹配时，优先级数字最小者胜；优先级相同则编号最小者胜。网段具体程度、端口区间宽窄不影响胜负。
- 端口区间为闭区间，包含两个端点；CIDR 主机位不影响所表示的网络范围。

## 设计

按记录协议（TCP/UDP/ICMP）各建一份索引（`src/protocolIndex.ts`）：

1. 把所有规则网段的边界切开，得到互不相交的地址段；每段内匹配的规则集合恒定。
2. 每段内再用端口区间端点做扫描线切分，预计算每个端口子区间的获胜规则（按 `(priority, id)` 排序的首个覆盖者）。
3. 单次裁决 = 地址段二分 + 段内端口表二分，与规则总数近似对数关系；多数流量无命中或规则大量交叠时不会退化。

整体替换即丢弃旧索引、按新集合重建，被删改的遮挡规则不再影响后续裁决。

## 构建与测试

```sh
npm install
npm test
```

测试覆盖：

- 正确性（`test/adjudication.test.ts`）：/0 与 /32 交叠按优先级而非具体程度裁决、同优先级编号决胜、端口端点闭区间、ICMP 无端口、CIDR 主机位掩掉、地址边界、删改遮挡规则后被遮挡规则生效、批量顺序一致、非法规则拒绝。
- 一致性（`test/fuzz.test.ts`）：随机规则与随机流量下，索引结果与朴素逐规则扫描完全一致。
- 资源（`test/performance.test.ts`）：2000 条同协议、网段大量交叠的规则；流量一半集中命中最低优先级规则、一半无匹配；连续 1000 批 × 10000 条。

本机实测（断言阈值：替换 ≤ 2s，总裁决 ≤ 15s，库持有内存 ≤ 128 MiB）：

```
replace=230ms, adjudicate 1000x10000=1468ms, heap delta=12.7 MiB
```
