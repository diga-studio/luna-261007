# least-privilege-advisor

最小权限建议库，由治理平台直接在进程内调用。分析数据与结果仅保存在进程内存中，
不做任何持久化、网络访问或端口监听。

## 使用

```ts
import { advise } from "least-privilege-advisor";

const advice = advise({
  now: Date.now(),          // 分析基准时刻 T（epoch 毫秒）
  grants: [                  // 上层解析后的最终有效授权
    { id: 1, coverage: [{ environment: "prod", resourceType: "db", action: "read" }] },
  ],
  events: [                  // 访问日志
    { triple: { environment: "prod", resourceType: "db", action: "read" },
      timestamp: Date.now() - 3600_000, success: true },
  ],
});
// advice.keep   —— 建议保留的授权编号（升序）
// advice.revoke —— 建议撤销的授权编号（升序）
```

## 规则

- 证据窗口为 `[T - 720h, T)`：仅窗口内的成功访问计入证据，同一三元组去重。
- 撤销后每个证据三元组仍须被至少一项保留授权覆盖；无证据时可撤销全部。
- 在所有可行保留方案中依次优化：
  1. 未被证据观察到、但仍被保留授权允许的三元组数量最少（按覆盖并集计）；
  2. 保留授权数量最少；
  3. 编号升序序列字典序最小。
- 结果与授权输入顺序、日志顺序、重复日志数量无关。

## 前提假设

- 一份快照对应一个用户；授权编号为唯一正整数（非法输入会抛错）。
- 所有授权已连续持有至少 30 天且覆盖范围未变；成功访问均能被当前授权覆盖。
- 搜索为精确算法，复杂度与“和证据有交集的授权数量”呈指数关系，
  适用于单用户授权规模（几十项以内）。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>=18）与 devDependency `typescript`。
