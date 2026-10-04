# graphql-namespace-delegation

一个内存中的 GraphQL 命名空间委派库：把多个只含查询的内部服务组合成单一 Schema，由上层直接调用，配置与执行状态全部保存在内存。

## 用法

```ts
import { createGateway } from "graphql-namespace-delegation";

const gateway = createGateway([
  {
    namespace: "acct",          // 唯一命名空间
    sdl: `type Query { invoice(id: ID!): Invoice } ...`, // 原始 SDL
    execute: (document, variableValues) => executeAgainstYourService(document, variableValues),
  },
  // ...更多服务
]);

const result = await gateway.execute(
  `{ a: acct { invoice(id: "1") { id __typename } } }`,
  {},            // 变量
  undefined,     // operationName（多操作文档时必填）
);
```

## 语义约定

- 组合 Schema 以 `Query` 为根，每个命名空间对应一个可空字段，返回该服务的查询根对象。
- 服务定义的所有具名类型（含查询根）统一改名为 `命名空间_原类型名`；内置标量、字段名、参数名、输入字段与枚举值不变。
- 支持对象、接口、联合、枚举、输入对象与递归类型；组合查询支持别名、命名/内联片段、变量及默认值、`@skip`/`@include` 与 `__typename`。
- 每次顶层命名空间字段（含别名）独立委派一次：类型名还原、变量裁剪后通过原始 Schema 校验，再交给该服务的执行回调。
- `__typename` 返回组合类型名；业务字符串、ID、枚举值原样保留；接口/联合的实际类型由注入的运行时判别决定，不依赖客户端显式选择 `__typename`。
- 上游错误的 `message` 保留，`path` 定位到组合查询的完整响应路径；非空错误传播遵循组合 Schema；某服务根结果为空不影响其他顶层响应键；同一上游错误不重复出现；被指令跳过的服务根不会触发上游调用。

## 构建与测试

```sh
npm install
npm test   # 编译 src 与 test，并用 node:test 运行全部测试
```
