# floodgate-geo-deny

FloodGate 地理 CIDR 阻断策略编译库（TypeScript，零运行时依赖）。

调用方提供已解析、字段合法的地理归属记录，库负责构建只读索引，并把
"待阻断国家集合 − 保护 CIDR" 编译为**精确且数量最少**的阻断 CIDR 流。
不涉及 CSV 解析、管理界面或路由下发；只处理静态数据。

## API

```ts
import { buildGeoIndex, compileDeny } from "floodgate-geo-deny";

const index = await buildGeoIndex(rows); // rows: AsyncIterable<{ cidr, country }>
for await (const cidr of compileDeny(index, ["CN", "RU"], ["10.0.0.0/8"])) {
  // 逐项产出的阻断 CIDR 字符串；先 IPv4 后 IPv6，族内按网络地址升序
}
```

- `buildGeoIndex(rows)`：消费一次性 `AsyncIterable`（最多 50 万条），返回可
  重复用于编译的只读索引。输入 CIDR 可带非零主机位（清零后参与匹配与判重）；
  同一规范化 CIDR 重复出现时以最后一条记录为准。
- `compileDeny(index, countries, protectedCidrs)`：`countries` 为待阻断国家
  集合（`Set` 或数组），`protectedCidrs` 最多 200 个。返回阻断 CIDR 字符串的
  `AsyncIterable`，逐项产出，不做全量物化。

## 语义

- 地理归属按最长前缀匹配决定；无归属地址始终放行；保护 CIDR 始终优先放行。
- 输出覆盖地址 `a` 当且仅当 `a` 的归属国家属于待阻断集合且不在任何保护 CIDR 内。
- IPv4（/0–/32）与 IPv6（/0–/128）分别处理；IPv4 映射的 IPv6 地址仍属 IPv6 空间。
- 输出为精确且最小的 CIDR 集合：互不重叠、兄弟网段已合并到无法继续合并。

## 实现要点

- 地址用 `bigint` 精确表示（IPv6 低 64 位无精度损失）。
- 构建：解析并规范化每条记录，按 `(start, len, 输入序号)` 排序后去重
  （同组保留序号最大者，即"末条优先"），得到按 `(start, len)` 有序的只读数组。
  不枚举地址、不展开为固定前缀。
- 编译：把索引前缀与保护 CIDR 归并成有序区间流，做一次 O(n) 栈式扫描。
  前缀区间只会嵌套或互不相交，因此栈顶即最长前缀匹配；栈内含保护区间时
  一律放行。扫描把原子区间标记为阻断/放行，相邻阻断段合并为极大区间后，
  用标准的 range→CIDR 算法产出最小网段集合，全程流式输出。
- 复杂度：构建 O(n log n)，编译 O(n + p log p)（p ≤ 200 为保护数量），
  输出规模 O(结果数量)；内存 O(n)，50 万条记录单次构建 + 完整消费一次
  编译结果的进程峰值 RSS 远低于 512 MiB（规模测试实测约 450 MiB，含测试
  框架自身开销）。

## 构建与测试

只需要 Node.js（≥ 22.18，利用原生 TypeScript 类型擦除运行测试）：

```sh
npm install
npm test        # = tsc 类型检查 + node --test
```

- `npm run build`：用 `typescript`（devDependency）做严格类型检查（`noEmit`）。
- 测试使用 Node 内置测试运行器，无其他依赖。

测试覆盖：

- `test/geo-holes.test.ts`：嵌套入选/未入选/再入选国家形成孔洞并叠加保护
  子网，在小 IPv4 范围内逐地址对照独立参考实现，检查无可合并兄弟网段；
  另有 100 轮随机化 fuzz 对照。
- `test/ipv6.test.ts`：IPv6 `/0` 扣除单个 `/128` 恰好输出 128 段；仅低位
  不同的地址无精度误判；规范化后重复 CIDR 末条优先；同一索引连续编译不同
  保护清单互不污染；IPv4 映射地址不折叠；输出逐项产出的惰性。
- `test/scale.test.ts`：50 万条乱序记录（25 万条不同 IPv6 前缀），完整消费
  编译结果，流式校验升序/不重叠并与独立参考模型抽样对照，实测并断言峰值
  RSS < 512 MiB，记录构建与编译耗时。
