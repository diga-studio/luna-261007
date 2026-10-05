# perm-reconcile

跨云有效权限对账库。输入是两个环境中已映射到同一逻辑角色、同一资源的完整策略快照，判断两份快照是否产生相同的访问决策，并给出可重放的漂移证据。

## 安装与测试

```sh
npm install
npm test
```

只依赖 Node.js 与 `typescript`(devDependency),无运行时依赖。

## API

### `evaluate(snapshot, request) => Action`

对单个请求求最终动作。`request` 含 `minute`(UTC 日内分钟 0–1439)、`ip`(IPv4)、`tag`(`low` / `medium` / `high`)。

匹配规则:请求同时命中策略的 `window`、任一 `cidr`、任一 `tag` 才算命中该策略。多个命中取最小 `priority`;同优先级按 `deny` → `require-approval` → `allow` 决定;无命中返回 `deny`。

- `window`:`start` 含、`end` 不含;`start > end` 表示跨午夜;`start === end` 表示全天。
- `cidrs`:IPv4 CIDR,可重复、可相互包含。

### `compare(left, right) => CompareResult`

在完整请求域(全部 IPv4 地址 × 1440 分钟 × 3 个 tag)上比较两份快照的实际访问决策。返回 `{ equivalent, evidence }`;`evidence` 中每项含 `request`、`left`、`right`,且满足 `evaluate(left, request) === left`、`evaluate(right, request) === right`、`left !== right`,可直接重放。

实现原理:决策只在 CIDR 边界与时间窗边界处变化,因此对两侧所有 CIDR 区间端点、时间窗端点切分出基本区间,每个区间取代表点求值即可覆盖整个请求域,无需枚举 2^32 个地址。

## 示例

```js
const { evaluate, compare } = require("perm-reconcile");

const left = {
  policies: [
    { priority: 20, action: "allow", cidrs: ["0.0.0.0/0"],
      window: { start: 0, end: 0 }, tags: ["high"] },
    { priority: 10, action: "deny",
      cidrs: ["255.255.255.255/32", "255.255.255.255/32"],
      window: { start: 1439, end: 1 }, tags: ["low", "medium", "high"] },
  ],
};
const right = { policies: [left.policies[0]] };

const result = compare(left, right);
// result.equivalent === false
// result.evidence[0].request => { minute: 0 或 1439, ip: "255.255.255.255", tag: "high" }
// evaluate(left, req) === "deny", evaluate(right, req) === "allow"
```
