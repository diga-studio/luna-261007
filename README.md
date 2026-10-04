# CampaignForge

批量 DTR（动态文本替换）解析库。模板以 JSON 区块加带默认值的 token 描述，
每次提交产生递增修订号并整体生效；批次在启动时绑定清单内各模板的最新修订，
之后的提交不影响该批次。修订通过本地 JSON 文件持久化，重启后最近 20 个修订仍可读取。

## 构建与测试

```sh
npm install
npm test
```

## 用法

```ts
import { CampaignForge } from "campaign-forge";

const forge = new CampaignForge({ storagePath: "./data" });

// 提交模板修订（整体生效，返回递增修订号）
forge.submitRevision("landing", {
  tokens: { product: "default-product" },
  blocks: { headline: "Get {{product}} today" },
});

// 读取最近 20 个修订（新的在前）
const history = forge.readHistory("landing");

// 启动批次：绑定清单内各模板的最新修订
const batch = forge.startBatch(["landing"]);
batch.submit({ templateId: "landing", params: { product: "shoes" } });
batch.finish();

for await (const result of batch.results()) {
  // 按页面输入顺序逐条交付，不必等输入结束
  console.log(result.output);
}

// 或者中途取消：取消完成后不再交付结果
await batch.cancel();
```

## 语义要点

- 占位符形如 `{{product}}`，只替换字符串叶值；同名查询参数优先，缺失时用默认值，空字符串是有效值；替换值不会被再次解释。
- 历史读取只开放最近 20 个修订；更早的修订若仍被存活批次绑定，则继续保留，批次完成或取消后失去保留资格。
- 取消在等待输入或消费暂停时都能完成，不依赖消费者继续拉取。
