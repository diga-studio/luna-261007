# CampaignForge 批量 DTR 解析库

TypeScript 实现的批量动态文本替换（DTR）解析库，模板修订本地文件持久化。

## 构建与测试

```sh
npm install
npm test
```

## API

```ts
import { CampaignForge } from "campaignforge-dtr";

const forge = new CampaignForge({ dataDir: "./data" });

// 提交模板修订：返回递增修订号，整体生效
const rev = forge.submitRevision("landing-a", {
  blocks: { headline: "Buy {{product}} now" },
  tokens: { product: { default: "shoes" } },
});

// 历史读取：最近 20 个修订（含当前），升序；重启后仍可读取
const history = forge.getHistory("landing-a");

// 启动批次：绑定清单内各模板最新修订，之后的提交不影响本批次
const batch = forge.startBatch(["landing-a"]);
batch.submitPage({ templateId: "landing-a", params: { product: "boots" } });
batch.endInput();
for await (const result of batch.results) {
  // 按页面输入顺序逐条交付，不必等输入结束
}
await batch.cancel(); // 取消后不再交付
```

## 语义

- 替换所有字符串叶值中的 `{{token}}`；同名查询参数优先（空字符串有效），缺失用默认值；替换值不二次解释；键名与非字符串值不变。
- 历史窗口为最近 20 个修订；窗口外修订仍被已绑定批次钉住，批次交付完毕或取消后失去保留资格。
- 持久化仅存本地文件（`dataDir/templates/<id>/revisions/<n>.json`），原子写入。
