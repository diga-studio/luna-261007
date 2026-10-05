import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecureVault, VaultError } from '../src/index.js';
import { ManualClock, PausableSource, collect, decode, textChunks } from './helpers.js';

const USER = 'alice';
const DOC = 'doc-1';

function setup(chunks: Uint8Array[], grant: { expiresAt: number | null; maxViews: number | null }) {
  const clock = new ManualClock();
  const source = new PausableSource(chunks);
  const vault = new SecureVault({ source, clock: () => clock.now });
  vault.setGrant(USER, DOC, grant);
  return { clock, source, vault };
}

test('maxViews=1：两个并发流同时进入首块读取，恰好一个交付，另一个在交付前失败', async () => {
  const { source, vault } = setup(textChunks('A', 'B'), { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken(USER, DOC);

  const it1 = vault.open(USER, token)[Symbol.asyncIterator]();
  const it2 = vault.open(USER, token)[Symbol.asyncIterator]();

  source.pause();
  const p1 = it1.next();
  const p2 = it2.next();
  await source.waitForPending(2);
  source.resume();

  const results = await Promise.allSettled([p1, p2]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(decode([fulfilled[0]!.value.value]), 'A');
  assert.ok(rejected[0]!.reason instanceof VaultError);
  assert.equal(rejected[0]!.reason.code, 'VIEWS_EXHAUSTED');

  // 获胜的流可继续读完剩余块，不再扣次。
  const winner = results[0]!.status === 'fulfilled' ? it1 : it2;
  const rest: Uint8Array[] = [];
  for (;;) {
    const r = await winner.next();
    if (r.done) break;
    rest.push(r.value);
  }
  assert.equal(decode(rest), 'B');
});

test('撤销后挂起的读取不得交付；重新授权后旧令牌与旧流不能复活', async () => {
  const { source, vault } = setup(textChunks('X', 'Y'), { expiresAt: null, maxViews: null });
  const oldToken = vault.issueToken(USER, DOC);
  const oldStream = vault.open(USER, oldToken)[Symbol.asyncIterator]();

  source.pause();
  const pending = oldStream.next();
  await source.waitForPending(1);

  vault.setGrant(USER, DOC, null); // 撤销
  source.resume();

  await assert.rejects(pending, (e: unknown) => e instanceof VaultError && e.code === 'ACCESS_REVOKED');
  await assert.rejects(oldStream.next(), (e: unknown) => e instanceof VaultError && e.code === 'ACCESS_REVOKED');

  // 重新授权（参数相同也产生全新授权）。
  vault.setGrant(USER, DOC, { expiresAt: null, maxViews: null });
  const newToken = vault.issueToken(USER, DOC);
  assert.notEqual(newToken, oldToken);

  // 旧令牌签名仍有效，open 不报错，但交付点必须拒绝。
  const revived = vault.open(USER, oldToken)[Symbol.asyncIterator]();
  await assert.rejects(revived.next(), (e: unknown) => e instanceof VaultError && e.code === 'ACCESS_REVOKED');
  // 旧流同样不能复活。
  await assert.rejects(oldStream.next(), (e: unknown) => e instanceof VaultError && e.code === 'ACCESS_REVOKED');

  // 新令牌的全新流可以正常交付。
  const fresh = await collect(vault.open(USER, newToken));
  assert.equal(decode(fresh), 'XY');
});

test('限次流多块只扣一次；读取等待期间越过期限则拒绝且次数不恢复', async () => {
  const { clock, source, vault } = setup(textChunks('A', 'B', 'C'), { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken(USER, DOC);
  const it = vault.open(USER, token)[Symbol.asyncIterator]();

  // 连续读两块，只消耗一次查看。
  assert.equal(decode([(await it.next()).value]), 'A');
  assert.equal(decode([(await it.next()).value]), 'B');

  // 第三块读取挂起期间，时钟越过令牌 60 秒期限。
  source.pause();
  const pending = it.next();
  await source.waitForPending(1);
  clock.now += 60_000;
  source.resume();

  await assert.rejects(pending, (e: unknown) => e instanceof VaultError && e.code === 'TOKEN_EXPIRED');
  await assert.rejects(it.next(), (e: unknown) => e instanceof VaultError && e.code === 'TOKEN_EXPIRED');

  // 已消耗的次数不恢复：无法再签发令牌。
  assert.throws(() => vault.issueToken(USER, DOC), (e: unknown) => e instanceof VaultError && e.code === 'VIEWS_EXHAUSTED');
});

test('签发不扣次数：先签发多个令牌，首个交付才计数', async () => {
  const { vault } = setup(textChunks('A'), { expiresAt: null, maxViews: 1 });
  const t1 = vault.issueToken(USER, DOC);
  const t2 = vault.issueToken(USER, DOC); // 签发不预留次数，允许

  assert.equal(decode(await collect(vault.open(USER, t1))), 'A');
  // 次数已用尽，第二个令牌的流在首块交付点失败。
  const it = vault.open(USER, t2)[Symbol.asyncIterator]();
  await assert.rejects(it.next(), (e: unknown) => e instanceof VaultError && e.code === 'VIEWS_EXHAUSTED');
});

test('令牌绑定用户：其他用户不能使用', async () => {
  const { vault } = setup(textChunks('A'), { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken(USER, DOC);
  assert.throws(() => vault.open('bob', token), (e: unknown) => e instanceof VaultError && e.code === 'USER_MISMATCH');
});

test('篡改令牌被拒绝', async () => {
  const { vault } = setup(textChunks('A'), { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken(USER, DOC);
  const [body] = token.split('.');
  const forged = `${body}.AAAA`;
  assert.throws(() => vault.open(USER, forged), (e: unknown) => e instanceof VaultError && e.code === 'TOKEN_INVALID');
  assert.throws(() => vault.open(USER, 'garbage'), (e: unknown) => e instanceof VaultError && e.code === 'TOKEN_INVALID');
});

test('期限边界：到达 expiresAt 或令牌 60 秒期限即失效', async () => {
  const clock = new ManualClock();
  const source = new PausableSource(textChunks('A'));
  const vault = new SecureVault({ source, clock: () => clock.now });

  // 授权期限边界：now == expiresAt 时已失效。
  vault.setGrant(USER, DOC, { expiresAt: clock.now + 5_000, maxViews: null });
  clock.now += 4_999;
  assert.ok(vault.issueToken(USER, DOC));
  clock.now += 1;
  assert.throws(() => vault.issueToken(USER, DOC), (e: unknown) => e instanceof VaultError && e.code === 'GRANT_EXPIRED');

  // 令牌期限边界：now == 签发时间 + 60s 时交付失败。
  vault.setGrant(USER, DOC, { expiresAt: null, maxViews: null });
  const issuedAt = clock.now;
  const token = vault.issueToken(USER, DOC);
  const it = vault.open(USER, token)[Symbol.asyncIterator]();
  clock.now = issuedAt + 59_999;
  assert.equal(decode([(await it.next()).value]), 'A');

  const token2 = vault.issueToken(USER, DOC);
  const it2 = vault.open(USER, token2)[Symbol.asyncIterator]();
  clock.now += 60_000;
  await assert.rejects(it2.next(), (e: unknown) => e instanceof VaultError && e.code === 'TOKEN_EXPIRED');
});

test('空块不计数不交付', async () => {
  const { vault } = setup(
    [new Uint8Array(0), ...textChunks('A'), new Uint8Array(0)],
    { expiresAt: null, maxViews: 1 },
  );
  const token = vault.issueToken(USER, DOC);
  assert.equal(decode(await collect(vault.open(USER, token))), 'A');
});

test('首块交付前取消不扣次数；交付后取消不退款', async () => {
  const { vault } = setup(textChunks('A', 'B'), { expiresAt: null, maxViews: 1 });
  const token = vault.issueToken(USER, DOC);

  // 未读就 return()：不扣次数。
  const early = vault.open(USER, token)[Symbol.asyncIterator]();
  await early.return!();

  // 读一块后 return()：次数已消耗，不退款。
  const it = vault.open(USER, token)[Symbol.asyncIterator]();
  assert.equal(decode([(await it.next()).value]), 'A');
  await it.return!();
  assert.throws(() => vault.issueToken(USER, DOC), (e: unknown) => e instanceof VaultError && e.code === 'VIEWS_EXHAUSTED');
});

test('无授权时签发失败', () => {
  const clock = new ManualClock();
  const vault = new SecureVault({ source: new PausableSource([]), clock: () => clock.now });
  assert.throws(() => vault.issueToken(USER, DOC), (e: unknown) => e instanceof VaultError && e.code === 'GRANT_NOT_FOUND');
});
