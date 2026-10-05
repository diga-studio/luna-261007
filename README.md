# least-privilege-advisor

最小权限建议库（TypeScript）。由治理平台直接在进程内调用：调用方传入单个用户的
分析快照，库返回全局最优的“保留 / 撤销”授权清单。分析数据与结果仅存在于进程
内存中，不做任何 I/O、持久化或网络访问。

## 使用

```ts
import { recommend } from 'least-privilege-advisor';

const { keep, revoke } = recommend({
  now: Date.now(),          // 调用方提供的时刻 T（epoch 毫秒）
  grants: [
    { id: 1, coverage: [{ environment: 'prod', resourceType: 'db', action: 'read' }] },
    // ...
  ],
  accesses: [
    { triple: { environment: 'prod', resourceType: 'db', action: 'read' },
      timestamp: /* epoch ms */, success: true },
    // ...
  ],
});
```

## 语义

- 证据窗口为 `[T - 720h, T)`：仅取窗口内的**成功**访问；失败访问、窗口外访问
  （含 T 时刻本身）不作为证据；同一三元组重复访问只算一份证据。
- 建议撤销后，每个证据三元组仍被至少一项保留授权覆盖；无证据时可撤销全部。
- 优化目标（按优先级）：
  1. 保留授权覆盖范围并集的大小最小（即“未观察到但仍被允许”的三元组最少）；
  2. 保留授权数量最少；
  3. 保留编号升序序列字典序最小。
- 结果为全局最优（精确分支定界搜索），与授权输入顺序、日志顺序及重复日志无关。
- 授权只能整项保留或撤销；编号必须为正整数且唯一，否则抛错。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试（node:test）
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js 与 devDependencies 中的 TypeScript，无运行时依赖。
