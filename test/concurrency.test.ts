import { test } from "node:test";
import assert from "node:assert/strict";
import { SecureVault, VaultError } from "../src/index.js";
import { ControllableSource, FakeClock, bytes, collectStrings } from "./helpers.js";

function isVaultError(code: string) {
  return (err: unknown) => err instanceof VaultError && err.code === code;
}

test("maxViews=1：两个流同时等待首块，恰好一个交付，另一个在交付前失败", async () => {
  const source = new ControllableSource();
  const clock = new FakeClock();
  const vault = new SecureVault({ source, clock: clock.clock });
  source.setChunks("doc", collectStrings(100));
  vault.setGrant("u", "doc", { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken("u", "doc");

  source.blockReads();
  const it1 = vault.open("u", token)[Symbol.asyncIterator]();
  const it2 = vault.open("u", token)[Symbol.asyncIterator]();
  const p1 = it1.next();
  const p2 = it2.next();

  // 确定性地等到两个流都停在内容源读取中，然后一起释放
  await source.waitForPending(2);
  source.releaseAll();

  const [r1, r2] = await Promise.allSettled([p1, p2]);
  const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
  const rejected = [r1, r2].filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one stream must deliver");
  assert.equal(rejected.length, 1, "exactly one stream must fail");
  const winner = fulfilled[0] as PromiseFulfilledResult<IteratorResult<Uint8Array>>;
  assert.equal(winner.value.done, false);
  assert.deepEqual([...winner.value.value], [...collectStrings(100)[0]!]);
  const loser = rejected[0] as PromiseRejectedResult;
  assert.ok(isVaultError("VIEWS_EXHAUSTED")(loser.reason), `loser must fail with VIEWS_EXHAUSTED, got ${loser.reason}`);

  // 输家后续 next() 也必须拒绝，不能交付任何字节
  const loserIt = r1.status === "rejected" ? it1 : it2;
  await assert.rejects(loserIt.next(), isVaultError("VIEWS_EXHAUSTED"));
});

test("读取挂起期间撤销：释放后不交付字节；重新授权后旧令牌与旧流不能复活", async () => {
  const source = new ControllableSource();
  const clock = new FakeClock();
  const vault = new SecureVault({ source, clock: clock.clock });
  source.setChunks("doc", collectStrings(10, 20));
  vault.setGrant("u", "doc", { expiresAt: null, maxViews: null });
  const oldToken = vault.issueToken("u", "doc");

  source.blockReads();
  const it = vault.open("u", oldToken)[Symbol.asyncIterator]();
  const pending = it.next();
  await source.waitForPending(1);

  // 撤销在读取完成之前返回
  vault.setGrant("u", "doc", null);
  source.releaseAll();
  source.unblockReads();

  await assert.rejects(pending, isVaultError("GRANT_SUPERSEDED"));
  // 后续 next() 也必须拒绝
  await assert.rejects(it.next(), isVaultError("GRANT_SUPERSEDED"));

  // 重新授权：新令牌可用
  vault.setGrant("u", "doc", { expiresAt: null, maxViews: null });
  const newToken = vault.issueToken("u", "doc");

  // 旧令牌签名仍有效，open 不报错，但首次交付必须失败
  const oldIt = vault.open("u", oldToken)[Symbol.asyncIterator]();
  await assert.rejects(oldIt.next(), isVaultError("GRANT_SUPERSEDED"));
  // 旧流不能复活
  await assert.rejects(it.next(), isVaultError("GRANT_SUPERSEDED"));

  // 新令牌正常交付
  source.unblockReads();
  const newIt = vault.open("u", newToken)[Symbol.asyncIterator]();
  const first = await newIt.next();
  assert.equal(first.done, false);
  assert.deepEqual([...first.value], [...collectStrings(10, 20)[0]!]);
});

test("限次流连续读多块只扣一次；等待期间越过令牌期限则拒绝且不退款", async () => {
  const source = new ControllableSource();
  const clock = new FakeClock();
  const vault = new SecureVault({ source, clock: clock.clock });
  source.setChunks("doc", collectStrings(10, 20, 30));
  vault.setGrant("u", "doc", { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken("u", "doc");

  source.blockReads();
  const it = vault.open("u", token)[Symbol.asyncIterator]();

  // 第一块：扣唯一一次
  const p1 = it.next();
  await source.waitForPending(1);
  source.releaseAll();
  const r1 = await p1;
  assert.equal(r1.done, false);

  // 第二块读取等待期间，时钟越过令牌 60 秒期限
  const p2 = it.next();
  await source.waitForPending(1);
  clock.advance(60_000);
  source.releaseAll();
  await assert.rejects(p2, isVaultError("TOKEN_EXPIRED"));
  await assert.rejects(it.next(), isVaultError("TOKEN_EXPIRED"));

  // 已消耗的次数不能恢复：授权本身仍有效，但次数已用尽
  assert.throws(() => vault.issueToken("u", "doc"), isVaultError("VIEWS_EXHAUSTED"));
});

test("限次流连续读多块只消耗一次，已扣次的流不因次数归零而中断", async () => {
  const source = new ControllableSource();
  const vault = new SecureVault({ source });
  const chunks = collectStrings(10, 20, 30);
  source.setChunks("doc", chunks);
  vault.setGrant("u", "doc", { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken("u", "doc");

  const received: Uint8Array[] = [];
  for await (const chunk of vault.open("u", token)) received.push(chunk);
  assert.deepEqual(received.map((c) => [...c]), chunks.map((c) => [...c]));

  // 唯一一次已消耗：新令牌签不出来
  assert.throws(() => vault.issueToken("u", "doc"), isVaultError("VIEWS_EXHAUSTED"));
});

test("open 不扣次数：签发的多个令牌可同时打开，交付时才结算", async () => {
  const source = new ControllableSource();
  const vault = new SecureVault({ source });
  source.setChunks("doc", collectStrings(5));
  vault.setGrant("u", "doc", { expiresAt: null, maxViews: 2 });
  const t1 = vault.issueToken("u", "doc");
  const t2 = vault.issueToken("u", "doc");
  const t3 = vault.issueToken("u", "doc");

  const a = vault.open("u", t1)[Symbol.asyncIterator]();
  const b = vault.open("u", t2)[Symbol.asyncIterator]();
  const c = vault.open("u", t3)[Symbol.asyncIterator]();
  assert.equal((await a.next()).done, false);
  assert.equal((await b.next()).done, false);
  // 第三个流首块交付时次数已尽
  await assert.rejects(c.next(), isVaultError("VIEWS_EXHAUSTED"));
});

test("空块不交付也不扣次；超过 64KiB 的块被拒绝", async () => {
  const source = new ControllableSource();
  const vault = new SecureVault({ source });
  source.setChunks("doc", [new Uint8Array(0), bytes(1, 2, 3)]);
  vault.setGrant("u", "doc", { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken("u", "doc");
  const it = vault.open("u", token)[Symbol.asyncIterator]();
  const r = await it.next();
  assert.deepEqual([...r.value as Uint8Array], [1, 2, 3]);
  assert.equal((await it.next()).done, true);

  source.setChunks("big", [new Uint8Array(64 * 1024 + 1)]);
  vault.setGrant("u", "big", { expiresAt: null, maxViews: null });
  const bigToken = vault.issueToken("u", "big");
  await assert.rejects(
    vault.open("u", bigToken)[Symbol.asyncIterator]().next(),
    /exceeds 64 KiB/,
  );
});
