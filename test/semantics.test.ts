import { test } from "node:test";
import assert from "node:assert/strict";
import { SecureVault, VaultError, TOKEN_TTL_MS } from "../src/index.js";
import { ControllableSource, FakeClock, collectStrings } from "./helpers.js";

function isVaultError(code: string) {
  return (err: unknown) => err instanceof VaultError && err.code === code;
}

function setup(maxViews: number | null = null, expiresAt: number | null = null) {
  const source = new ControllableSource();
  const clock = new FakeClock();
  const vault = new SecureVault({ source, clock: clock.clock });
  source.setChunks("doc", collectStrings(10, 20, 30));
  vault.setGrant("u", "doc", { expiresAt, maxViews });
  return { source, clock, vault };
}

test("issueToken：无授权、授权过期、次数用尽时拒绝", () => {
  const { clock, vault } = setup(1, 2_000_000);
  assert.throws(() => vault.issueToken("u", "missing"), isVaultError("NO_GRANT"));
  assert.throws(() => vault.issueToken("nobody", "doc"), isVaultError("NO_GRANT"));

  const token = vault.issueToken("u", "doc");
  assert.equal(typeof token, "string");

  clock.now = 2_000_000; // 到达 expiresAt 即失效
  assert.throws(() => vault.issueToken("u", "doc"), isVaultError("GRANT_EXPIRED"));

  clock.now = 1_000_000;
  const vault2 = new SecureVault({ source: new ControllableSource(), clock: clock.clock });
  vault2.setGrant("u", "doc", { expiresAt: null, maxViews: 0 });
  assert.throws(() => vault2.issueToken("u", "doc"), isVaultError("VIEWS_EXHAUSTED"));
  void token;
});

test("open：坏签名、篡改载荷、用户绑定不符都被拒绝", () => {
  const { vault } = setup();
  const token = vault.issueToken("u", "doc");

  assert.throws(() => vault.open("u", "garbage"), isVaultError("INVALID_TOKEN"));
  assert.throws(() => vault.open("u", token.slice(0, -2) + "xx"), isVaultError("INVALID_TOKEN"));

  // 篡改载荷：解出 body 改 userId 后拼上原签名
  const body = token.split(".")[0]!;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  payload.userId = "attacker";
  const forged = Buffer.from(JSON.stringify(payload)).toString("base64url") + "." + token.split(".")[1]!;
  assert.throws(() => vault.open("attacker", forged), isVaultError("INVALID_TOKEN"));

  // 合法令牌但用户不符
  assert.throws(() => vault.open("other", token), isVaultError("USER_MISMATCH"));
});

test("授权期限边界：到达 expiresAt 的当刻起交付被拒绝", async () => {
  const { clock, vault } = setup(null, 1_005_000);
  const token = vault.issueToken("u", "doc");
  const it = vault.open("u", token)[Symbol.asyncIterator]();

  clock.now = 1_004_999;
  assert.equal((await it.next()).done, false);

  clock.now = 1_005_000; // 恰好到达 expiresAt
  await assert.rejects(it.next(), isVaultError("GRANT_EXPIRED"));
  await assert.rejects(it.next(), isVaultError("GRANT_EXPIRED"));
});

test("令牌期限边界：签发后 60 秒整交付被拒绝，59.999 秒可以", async () => {
  const { clock, vault } = setup();
  const token = vault.issueToken("u", "doc");

  clock.now += TOKEN_TTL_MS - 1;
  const it1 = vault.open("u", token)[Symbol.asyncIterator]();
  assert.equal((await it1.next()).done, false);

  clock.now = 1_000_000 + TOKEN_TTL_MS;
  const it2 = vault.open("u", token)[Symbol.asyncIterator]();
  await assert.rejects(it2.next(), isVaultError("TOKEN_EXPIRED"));
});

test("撤销不收回已交付字节，但撤销返回后不再交付新字节", async () => {
  const { vault } = setup();
  const token = vault.issueToken("u", "doc");
  const it = vault.open("u", token)[Symbol.asyncIterator]();

  const first = await it.next();
  assert.equal(first.done, false);
  assert.deepEqual([...first.value as Uint8Array], [...collectStrings(10)[0]!]);

  vault.setGrant("u", "doc", null);
  await assert.rejects(it.next(), isVaultError("GRANT_SUPERSEDED"));
  await assert.rejects(it.next(), isVaultError("GRANT_SUPERSEDED"));
});

test("相同参数重新授权：计数重置，旧令牌与旧流失效", async () => {
  const { vault } = setup(1);
  const oldToken = vault.issueToken("u", "doc");
  const oldIt = vault.open("u", oldToken)[Symbol.asyncIterator]();
  assert.equal((await oldIt.next()).done, false); // 用掉唯一一次

  vault.setGrant("u", "doc", { expiresAt: null, maxViews: 1 }); // 相同参数，仍是新授权
  await assert.rejects(oldIt.next(), isVaultError("GRANT_SUPERSEDED"));

  const newToken = vault.issueToken("u", "doc"); // 计数已重置
  assert.notEqual(newToken, oldToken);
  const it = vault.open("u", newToken)[Symbol.asyncIterator]();
  assert.equal((await it.next()).done, false);

  // 旧令牌不能在新授权下交付
  const stale = vault.open("u", oldToken)[Symbol.asyncIterator]();
  await assert.rejects(stale.next(), isVaultError("GRANT_SUPERSEDED"));
});

test("首块前 return() 不扣次；首块后 return() 不退款", async () => {
  const { vault } = setup(1);
  const token = vault.issueToken("u", "doc");

  // 未读就取消：不扣次
  const early = vault.open("u", token)[Symbol.asyncIterator]();
  await early.return!();
  const token2 = vault.issueToken("u", "doc"); // 次数仍在

  // 交付首块后取消：不退款
  const it = vault.open("u", token2)[Symbol.asyncIterator]();
  assert.equal((await it.next()).done, false);
  await it.return!();
  assert.throws(() => vault.issueToken("u", "doc"), isVaultError("VIEWS_EXHAUSTED"));
});

test("内容源读失败不扣首块次数", async () => {
  const source = new ControllableSource();
  source.setChunks("doc", collectStrings(10));
  const failing = {
    open(): AsyncIterable<Uint8Array> {
      return (async function* () {
        throw new Error("source blew up");
      })();
    },
  };
  const vault = new SecureVault({ source: failing });
  vault.setGrant("u", "doc", { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken("u", "doc");
  await assert.rejects(vault.open("u", token)[Symbol.asyncIterator]().next(), /blew up/);
  // 没扣次：换成正常源后仍能交付
  void source;
  const vault2 = new SecureVault({ source });
  vault2.setGrant("u", "doc", { expiresAt: null, maxViews: 1 });
  const token2 = vault2.issueToken("u", "doc");
  assert.equal((await vault2.open("u", token2)[Symbol.asyncIterator]().next()).done, false);
});

test("同一令牌可打开多个流，每个流分别计一次", async () => {
  const { vault } = setup(2);
  const token = vault.issueToken("u", "doc");
  const a = vault.open("u", token)[Symbol.asyncIterator]();
  const b = vault.open("u", token)[Symbol.asyncIterator]();
  assert.equal((await a.next()).done, false);
  assert.equal((await b.next()).done, false);
  assert.throws(() => vault.issueToken("u", "doc"), isVaultError("VIEWS_EXHAUSTED"));
});
