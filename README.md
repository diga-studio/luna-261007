# gift-pack-picking-planner

礼包整单拣货规划库（纯内存，无接口层），由上层履约程序直接调用。

## 规则

- 输入：一批已获批准、准备进入 Picking 的订单（已展开为实际商品变体及件数）+ 固定库存快照。
- 订单只能整单入选或整单不入选；入选订单对任一变体的合计需求不得超过其库存。
- 首要目标：入选订单数最多；数量相同时，入选提交序号升序名单字典序最小（不是序号总和最小）。
- 规划期间库存快照保持不变，不执行真实扣库。

## 用法

```ts
import { planPicking } from "gift-pack-picking-planner";

const plan = planPicking(orders, inventory);
// plan.selectedOrders：入选订单，按提交序号升序
```

## 开发

```sh
npm install
npm test        # 编译 src 与 test 后用 node:test 运行
npm run build   # 仅编译库到 dist/
```

## 实现说明

按提交序号升序做“优先入选”的深度优先搜索 + 分支限界。该枚举顺序下，
相同入选数的方案按名单字典序从小到大被发现，因此第一个达到最大入选数的
方案即字典序最小方案；之后上界不超过当前最优的分支均可剪枝。
