import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CampaignForge, renderTemplate } from "../src/index";
import type { PageResult, Template } from "../src/index";

function makeTemplate(tag: string): Template {
  return {
    blocks: { headline: `rev-${tag}: {{product}}`, sub: ["{{gift}}"] },
    tokens: { product: { default: `default-${tag}` }, gift: { default: `gift-${tag}` } },
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "campaignforge-"));
}

async function collect(iterable: AsyncIterable<PageResult>): Promise<PageResult[]> {
  const out: PageResult[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

test("批次尚未收到首条页面时跨越20次修订，仍使用绑定修订", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  forge.submitRevision("t1", makeTemplate("1"));
  const boundTemplate = makeTemplate("1");

  const batch = forge.startBatch(["t1"]);
  // 首条页面到达前，同一模板跨越 20 次修订
  for (let i = 2; i <= 21; i++) forge.submitRevision("t1", makeTemplate(String(i)));
  assert.equal(forge.getHistory("t1")[0]!.revision, 2); // 修订1已离开保留窗口

  batch.submitPage({ templateId: "t1", params: { product: "boots" } });
  batch.submitPage({ templateId: "t1", params: {} });
  batch.endInput();

  const results = await collect(batch.results);
  assert.equal(results.length, 2);
  // 与使用该批次绑定修订独立执行的全量替换完全一致
  assert.deepEqual(results[0]!.output, renderTemplate(boundTemplate, { product: "boots" }));
  assert.deepEqual(results[1]!.output, renderTemplate(boundTemplate, {}));
  assert.equal(results[0]!.revision, 1);
  assert.equal((results[0]!.output as any).headline, "rev-1: boots");
  forge.close();
});

test("结果按页面输入顺序逐条交付，不必等输入结束", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  forge.submitRevision("t1", makeTemplate("1"));
  const batch = forge.startBatch(["t1"]);

  const iterator = batch.results[Symbol.asyncIterator]();
  batch.submitPage({ templateId: "t1", params: { product: "a" } });
  const first = await iterator.next(); // 输入未结束即可交付
  assert.equal(first.done, false);
  assert.equal(first.value.sequence, 1);
  assert.equal((first.value.output as any).headline, "rev-1: a");

  batch.submitPage({ templateId: "t1", params: { product: "b" } });
  batch.submitPage({ templateId: "t1", params: { product: "c" } });
  const second = await iterator.next();
  const third = await iterator.next();
  assert.deepEqual(
    [first.value.sequence, second.value!.sequence, third.value!.sequence],
    [1, 2, 3],
  );
  batch.endInput();
  assert.equal((await iterator.next()).done, true);
  forge.close();
});

test("等待输入时取消：取消完成后不再交付结果", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  forge.submitRevision("t1", makeTemplate("1"));
  const batch = forge.startBatch(["t1"]);

  const iterator = batch.results[Symbol.asyncIterator]();
  const pending = iterator.next(); // 正在等待首条页面输入
  await batch.cancel();
  const after = await pending;
  assert.equal(after.done, true);
  assert.equal((await iterator.next()).done, true);
  assert.throws(() => batch.submitPage({ templateId: "t1", params: {} }), /cancelled/);
  forge.close();
});

test("暂停消费时取消：已入队未消费的结果不再交付", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  forge.submitRevision("t1", makeTemplate("1"));
  const batch = forge.startBatch(["t1"]);

  batch.submitPage({ templateId: "t1", params: { product: "a" } });
  batch.submitPage({ templateId: "t1", params: { product: "b" } });
  // 消费方暂停，不拉取结果
  await batch.cancel();

  const results = await collect(batch.results);
  assert.deepEqual(results, []);
  forge.close();
});

test("之后的提交不影响进行中的批次，新批次重新绑定最新修订", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  forge.submitRevision("t1", makeTemplate("1"));
  const batch1 = forge.startBatch(["t1"]);
  forge.submitRevision("t1", makeTemplate("2"));
  const batch2 = forge.startBatch(["t1"]);

  batch1.submitPage({ templateId: "t1", params: {} });
  batch2.submitPage({ templateId: "t1", params: {} });
  batch1.endInput();
  batch2.endInput();

  const [r1, r2] = await Promise.all([collect(batch1.results), collect(batch2.results)]);
  assert.equal((r1[0]!.output as any).headline, "rev-1: default-1");
  assert.equal((r2[0]!.output as any).headline, "rev-2: default-2");
  assert.equal(r1[0]!.revision, 1);
  assert.equal(r2[0]!.revision, 2);
  forge.close();
});

test("批次活跃期间钉住旧修订，交付完毕后旧修订失去保留资格", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  forge.submitRevision("t1", makeTemplate("1"));
  const rev1File = path.join(dir, "templates", "t1", "revisions", "1.json");

  const batch = forge.startBatch(["t1"]);
  for (let i = 2; i <= 25; i++) forge.submitRevision("t1", makeTemplate(String(i)));
  assert.ok(fs.existsSync(rev1File), "批次活跃时，窗口外的绑定修订仍保留");

  batch.submitPage({ templateId: "t1", params: {} });
  batch.endInput();
  const results = await collect(batch.results);
  assert.equal(results.length, 1);
  assert.ok(!fs.existsSync(rev1File), "批次交付完毕后，窗口外旧修订被清理");

  // 历史读取不受清理影响：仍是最近20个
  const history = forge.getHistory("t1");
  assert.equal(history.length, 20);
  assert.equal(history[0]!.revision, 6);
  forge.close();
});

test("清单外模板的页面被拒绝", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  forge.submitRevision("t1", makeTemplate("1"));
  const batch = forge.startBatch(["t1"]);
  assert.throws(() => batch.submitPage({ templateId: "t2", params: {} }), /not in this batch/);
  await batch.cancel();
  forge.close();
});

test("多模板批次：逐条交付且与绑定修订独立替换一致", async () => {
  const dir = tempDir();
  const forge = new CampaignForge({ dataDir: dir });
  const tA = makeTemplate("A1");
  const tB: Template = {
    blocks: { banner: "{{city}} sale {{product}}" },
    tokens: { city: { default: "SH" }, product: { default: "tea" } },
  };
  forge.submitRevision("ta", tA);
  forge.submitRevision("tb", tB);

  const batch = forge.startBatch(["ta", "tb"]);
  forge.submitRevision("ta", makeTemplate("A2")); // 不影响本批次

  const inputs = [
    { templateId: "tb", params: { city: "BJ" } },
    { templateId: "ta", params: { product: "hat" } },
    { templateId: "tb", params: {} },
    { templateId: "ta", params: {} },
  ];
  for (const page of inputs) batch.submitPage(page);
  batch.endInput();

  const results = await collect(batch.results);
  assert.equal(results.length, 4);
  const bound: Record<string, Template> = { ta: tA, tb: tB };
  for (let i = 0; i < inputs.length; i++) {
    assert.equal(results[i]!.sequence, i + 1);
    assert.equal(results[i]!.templateId, inputs[i]!.templateId);
    assert.deepEqual(results[i]!.output, renderTemplate(bound[inputs[i]!.templateId]!, inputs[i]!.params));
  }
  forge.close();
});
