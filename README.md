# floodgate-geo-deny

FloodGate 地理 CIDR 阻断策略编译库（TypeScript）。调用方提供已解析且字段合法的
本地地理归属记录，库负责构建可复用的只读索引，并把「待阻断国家集合 − 保护
CIDR」编译成精确、最小的阻断 CIDR 清单。库只处理静态数据：不做 CSV 解析、
管理界面、路由下发、并发更新、持久化或崩溃恢复。

## API

```ts
import { buildGeoIndex, compileDeny } from "floodgate-geo-deny";

const index = await buildGeoIndex(rows); // rows: AsyncIterable<{ cidr, country }>
for await (const cidr of compileDeny(index, ["CN", "RU"], ["10.0.0.0/8", "::1/128"])) {
  // 逐项产出的阻断 CIDR；IPv4 段（升序）在前，IPv6 段（升序）在后
}
```

- `buildGeoIndex(rows)`：消费一次性 `AsyncIterable`（最多 50 万条，顺序任意），
  返回可重复用于编译的只读 `GeoIndex`。
- `compileDeny(index, countries, protectedCidrs)`：按待阻断国家集合与最多 200 个
  保护 CIDR，返回阻断 CIDR 字符串的 `AsyncIterable`，逐项产出、不物化全量结果。

## 语义

- 对每个 IPv4/IPv6 地址：输出覆盖它，当且仅当其地理归属（最长前缀匹配）属于
  待阻断国家，且不在任何保护 CIDR 内。无归属地址始终放行；保护 CIDR 优先放行。
- 输入 CIDR 可带非零主机位，清零后参与匹配与判重；同一规范化 CIDR 重复出现时
  以输入中最后一条为准。
- 支持 IPv4 /0–/32、IPv6 /0–/128；IPv4 映射的 IPv6 地址（如 `::ffff:10.0.0.0`）
  仍属 IPv6 空间，不折叠为 IPv4。
- 输出是精确且数量最少的 CIDR 集合：互不重叠、可合并的兄弟网段已全部合并；
  同一地址族内按网络地址数值升序。

## 实现要点

- 地址用 `BigInt` 表示（IPv6 全 128 位精度，低位差异不会丢失）。
- 索引是**按 (网络地址, 前缀长) 排序的类型化数组表**（约 25 字节/记录，在 V8
  堆外）：构建时稳定排序去重（末条优先），编译时对地址空间做分治递归，每个
  节点用二分查找切分记录区间，而不是扫描全部记录或枚举地址。
- 只含单条记录的区间直接解析（路径兄弟扣除法），不逐位下探；满子树向上合并，
  保证输出最小且升序。
- 50 万条乱序记录（含 25 万条不同 IPv6 前缀）单次构建 + 完整消费一次编译，
  实测峰值 RSS 约 305–325 MiB（限制 512 MiB），构建约 0.8 s、编译约 1.7 s。

## 构建与测试

```sh
npm install
npm test        # tsc 构建 + vitest（功能、随机差分、50 万规模/RSS）
```

测试覆盖：嵌套孔洞 + 保护子网的逐地址参考对照与可合并性检查；IPv6 /0 扣除
单个 /128（恰好 128 段）与低位精度；规范化重复的末条优先；同一索引连续编译
不同保护清单的隔离性；随机差分（IPv4 逐地址、IPv6 采样）；50 万条规模下完整
消费编译结果并实测峰值 RSS 与耗时（在独立子进程中测量）。
