# cross-cloud-policy-recon

跨云有效权限对账库。输入是两个环境中已映射到同一逻辑角色、同一资源的完整策略快照，
判断两份快照是否产生相同的访问决策，并给出可重放的漂移证据。

## 使用

```bash
npm install
npm test
```

```ts
import { evaluate, compare } from "cross-cloud-policy-recon";

const action = evaluate(snapshot, { minute: 600, ip: "10.0.0.1", tag: "high" });
// => "allow" | "deny" | "require-approval"

const result = compare(leftSnapshot, rightSnapshot);
// result.equal: boolean
// result.evidence: Request[] —— 每个证据请求分别交给 evaluate，左右动作必然不同
```

## 语义

- 每条策略含 `priority`(1-100，越小越优先)、`action`、`cidrs`、`window`、`tags`。
- `window` 为 UTC 日内分钟 0-1439，起点包含、终点不包含；`start > end` 跨午夜；`start === end` 全天。
- 请求需同时命中时间、任一 CIDR、任一 tag 才匹配该策略。
- 多个匹配取最小 `priority`；同优先级按 deny > require-approval > allow 决定。
- 无匹配策略时返回 `deny`。

## compare 原理

请求域为全部 IPv4 × 1440 分钟 × 3 个 tag，无法枚举。compare 收集两份快照中所有
CIDR 区间端点与所有 window 边界，把 IP 空间和分钟轴切成基本单元；同一单元内任何
策略的匹配状态不变，因此逐单元取代表点重放 evaluate 即等价于全量比较。
