# gift-pack-picking-planner

礼包整单拣货规划库（TypeScript），由上层履约程序直接在进程内调用。
库存快照、候选订单与规划结果均只保存在内存中，组件不执行真实扣库。

## 规则

- 每单对应一位收件人的一个礼包，已展开为具体商品变体（`VariantId`）及所需件数；
  SKU、尺码或颜色不同即为不同变体，库存不可互相替代。
- 订单只能整单入选或整单不入选；入选订单对任一变体的合计需求不得超过其库存。
- 首要目标：入选订单数最多。
- 并列时：将各方案入选提交序号按升序排列，取字典序最小的完整名单。

## 使用

```ts
import { planPicking } from "gift-pack-picking-planner";

const plan = planPicking(
  [
    { sequence: 1, demands: { cup: 2, badge: 2 } },
    { sequence: 2, demands: { cup: 1, badge: 1 } },
    { sequence: 3, demands: { cup: 1, badge: 1 } },
  ],
  { cup: 2, badge: 2 },
);
// plan.selectedOrders -> 序号为 2、3 的订单
```

## 构建与测试

```sh
npm install
npm test
```
