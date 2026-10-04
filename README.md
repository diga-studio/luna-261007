# exit-waterfall

进程内的股权退出清算计算库（TypeScript，零运行时依赖）。支持非参与优先股、
无限参与优先股与封顶参与优先股，全部计算使用任意精度整数（bigint）与约分
有理数，不使用浮点数、误差阈值或迭代逼近。

## 安装与测试

```sh
npm install
npm test        # tsc 编译后用 node:test 运行全部测试
npm run build   # 仅编译到 dist/
```

## 模型

一张资本表 = 一个普通股类别（股数 > 0）+ 若干同一清算顺位的优先股类别。
每个优先类有唯一 `id`、转换后股数 `s`、优先清算总额 `L`（分）、是否参与
剩余分配，参与类可选总收益上限 `C`（`C >= L`）。股数与金额可达 10^18，
以十进制整数字符串（或 number / bigint）传入。

- `V <= sum(L)`：普通股得 0，各优先类按 `L` 占比分享全部资金，无人转换。
- `V > sum(L)`：设普通股每股所得为 `r`。普通股得 `s0 * r`；未转换非参与类
  得 `L`；未转换参与类得 `min(L + s*r, C)`（无 `C` 则无上限）；转换类得
  `s*r`。每个类别在最终同一个 `r` 下取转换/不转换中较高者，相等时保留
  优先身份；所有类别所得之和严格等于 `V`。

## API

```ts
import { allocate, breakpoints, rationalToString } from "exit-waterfall";

const table = {
  commonShares: "100",
  preferred: [
    { id: "P1", shares: "100", liquidation: "100", participating: true, cap: "200" },
    { id: "P2", shares: "100", liquidation: "100", participating: false },
  ],
};

allocate(table, "900");
// => { common: {num: 300n, den: 1n},
//      preferred: [ {id:"P1", amount:{num:300n,den:1n}, converted:true},
//                   {id:"P2", amount:{num:300n,den:1n}, converted:true} ] }

breakpoints(table).map(rationalToString); // => ["200", "400", "600"]
```

- `allocate(table, exitValue)`：返回各类精确所得（约分有理数，单位为分，
  不做分币舍入）及是否转换为普通股。
- `breakpoints(table)`：估值从 0 增长到无穷大时，任一类所得斜率或转换
  状态改变的全部临界估值，精确有理数升序去重，不含 0。

## 算法

转换选择、参与上限与资金守恒通过同一个 `r` 同时确定，而不是先决定转换
再修补分配：总 payout 是 `r` 的连续分段线性严格递增函数
`V(r) = r * slope + constant`，其中 `slope`/`constant` 只在每个类的
临界事件处变化（非参与类在 `r = L/s` 转换；封顶参与类在 `r = (C-L)/s`
触顶、在 `r = C/s` 转换）。把全部事件按 `r` 精确排序后扫描一次：

- `allocate`：在事件区间上定位唯一满足守恒的 `r`（区间内有
  `r = (V - constant) / slope`），再按严格大于规则逐类判定转换身份。
- `breakpoints`：扫描中对每个事件输出 `V = r * slope + constant`，
  加上 `sum(L)` 后排序去重。即使某临界点上各类斜率变化相互抵消
  （总速率不变），只要任一类的分配规则改变，该事件仍会出现在结果中。

`n` 个优先类时，两个操作都是 `O(n log n)` 时间、`O(n)` 额外空间，
不枚举转换组合，也不对每个候选临界值重扫全表。
