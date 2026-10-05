import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustodyLedger } from '../src/ledger.js';
import { verifyReport } from '../src/report.js';
import { LedgerStore } from '../src/store.js';
import type { Credential, CustodyEvent, CustodyReport } from '../src/types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'custody-'));
}

/** 独立遍历原始事件日志，得出某记录应有的报告事件序列。 */
function independentTraversal(dir: string, recordId: string): CustodyEvent[] {
  const store = (LedgerStore as any).open(dir);
  const events: CustodyEvent[] = [];
  for (const { event } of store.iterateEvents()) {
    if (event.recordId === recordId) events.push(event);
  }
  store.close();
  events.sort((a, b) => (a.timestamp - b.timestamp) || (a.seq - b.seq));
  return events;
}

function eventsEqual(a: CustodyEvent[], b: CustodyEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].seq !== b[i].seq || a[i].recordId !== b[i].recordId
      || a[i].timestamp !== b[i].timestamp || a[i].actor !== b[i].actor
      || Buffer.compare(Buffer.from(a[i].body), Buffer.from(b[i].body)) !== 0) return false;
  }
  return true;
}

interface Fixture {
  dir: string;
  credential: Credential;
  recordIds: string[];
}

/** 多记录交错追加，含大量同秒事件。salt 用于区分不同账册的内容。 */
function buildFixture(salt = ''): Fixture {
  const dir = tempDir();
  const ledger = CustodyLedger.open(dir);
  const recordIds = ['alpha', 'beta', 'gamma', 'delta'];
  const baseTs = 1_700_000_000;
  let seq = 0;
  for (let round = 0; round < 50; round++) {
    for (const rid of recordIds) {
      seq++;
      // 同一秒内的同秒事件：每 5 个事件共享一个秒
      const timestamp = baseTs + Math.floor(seq / 5);
      ledger.appendEvent({
        recordId: rid,
        timestamp,
        actor: `operator-${seq % 7}`,
        body: `body-${salt}${rid}-${seq}`,
      });
    }
  }
  // 额外塞入一批完全同秒的事件
  for (let i = 0; i < 40; i++) {
    ledger.appendEvent({
      recordId: recordIds[i % recordIds.length],
      timestamp: baseTs,
      actor: 'burst',
      body: `burst-${salt}${i}`,
    });
  }
  const credential = ledger.seal();
  ledger.close();
  return { dir, credential, recordIds };
}

test('交错追加与同秒事件：报告与独立遍历一致，非空与空报告均通过验真', () => {
  const fx = buildFixture();
  try {
    const ledger = CustodyLedger.open(fx.dir);
    for (const rid of fx.recordIds) {
      const report = ledger.generateReport(rid);
      assert.ok(report.events.length > 0);
      assert.ok(eventsEqual(report.events, independentTraversal(fx.dir, rid)), `report mismatch for ${rid}`);
      assert.ok(verifyReport(fx.credential, rid, report), `verify failed for ${rid}`);
    }
    const empty = ledger.generateReport('no-such-record');
    assert.equal(empty.events.length, 0);
    assert.ok(verifyReport(fx.credential, 'no-such-record', empty), 'empty report should verify');
    ledger.close();
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('空账册封存后空报告可验真，凭证不超过128字节', () => {
  const dir = tempDir();
  try {
    const ledger = CustodyLedger.open(dir);
    const credential = ledger.seal();
    assert.ok(credential.length <= 128);
    ledger.close();
    const reopened = CustodyLedger.open(dir);
    const report = reopened.generateReport('anything');
    assert.equal(report.events.length, 0);
    assert.ok(verifyReport(credential, 'anything', report));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('关闭重开后报告与封存前一致', () => {
  const fx = buildFixture();
  try {
    const before = CustodyLedger.open(fx.dir);
    const r1 = before.generateReport('alpha');
    before.close();
    const after = CustodyLedger.open(fx.dir);
    const r2 = after.generateReport('alpha');
    after.close();
    assert.ok(eventsEqual(r1.events, r2.events));
    assert.ok(verifyReport(fx.credential, 'alpha', r2));
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('篡改报告：删事件、换序、改正文、拼入他记录、伪报为空、错凭证均不通过', () => {
  const fx = buildFixture();
  const other = buildFixture('other-');
  try {
    const ledger = CustodyLedger.open(fx.dir);
    const rid = 'alpha';
    const good = ledger.generateReport(rid);
    assert.ok(good.events.length >= 10);
    const clone = (): CustodyReport => JSON.parse(JSON.stringify(good, (k, v) =>
      v && v.type === 'Buffer' ? Buffer.from(v.data) : v), ) as CustodyReport;

    // 删掉中间事件
    {
      const r = clone();
      r.events.splice(Math.floor(r.events.length / 2), 1);
      assert.equal(verifyReport(fx.credential, rid, r), false, 'removed middle event');
    }
    // 删掉首尾事件
    {
      const r = clone();
      r.events.shift();
      assert.equal(verifyReport(fx.credential, rid, r), false, 'removed first event');
      const r2 = clone();
      r2.events.pop();
      assert.equal(verifyReport(fx.credential, rid, r2), false, 'removed last event');
    }
    // 交换同秒事件
    {
      const r = clone();
      let i = 0;
      while (i + 1 < r.events.length && r.events[i].timestamp !== r.events[i + 1].timestamp) i++;
      assert.ok(i + 1 < r.events.length, 'need same-second pair');
      [r.events[i], r.events[i + 1]] = [r.events[i + 1], r.events[i]];
      assert.equal(verifyReport(fx.credential, rid, r), false, 'swapped same-second events');
    }
    // 替换正文
    {
      const r = clone();
      r.events[2] = { ...r.events[2], body: new TextEncoder().encode('forged body') };
      assert.equal(verifyReport(fx.credential, rid, r), false, 'replaced body');
    }
    // 拼入另一记录的事件
    {
      const beta = ledger.generateReport('beta');
      const r = clone();
      r.events.push(beta.events[0]);
      r.events.sort((a, b) => (a.timestamp - b.timestamp) || (a.seq - b.seq));
      assert.equal(verifyReport(fx.credential, rid, r), false, 'spliced other record event');
    }
    // 拼入另一记录的证明材料
    {
      const beta = ledger.generateReport('beta');
      const r = clone();
      r.proof = beta.proof;
      assert.equal(verifyReport(fx.credential, rid, r), false, 'spliced other record proof');
    }
    // 存在记录伪报为空（用不存在记录的空报告冒充）
    {
      const empty = ledger.generateReport('ghost-record');
      const forged: CustodyReport = { ...empty, recordId: rid };
      assert.equal(verifyReport(fx.credential, rid, forged), false, 'existing record faked as empty');
    }
    // 另一账册的凭证
    {
      assert.equal(verifyReport(other.credential, rid, good), false, 'wrong credential');
    }
    // 合法报告对照：应通过
    assert.ok(verifyReport(fx.credential, rid, good));
    ledger.close();
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
    rmSync(other.dir, { recursive: true, force: true });
  }
});

test('封存后拒绝追加与重复封存', () => {
  const dir = tempDir();
  try {
    const ledger = CustodyLedger.open(dir);
    ledger.appendEvent({ recordId: 'r', actor: 'a', body: 'x' });
    ledger.seal();
    assert.throws(() => ledger.appendEvent({ recordId: 'r', actor: 'a', body: 'y' }), /sealed/);
    assert.throws(() => ledger.seal(), /sealed/);
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('全局序号唯一递增，时间默认取当前UTC秒', () => {
  const dir = tempDir();
  try {
    const ledger = CustodyLedger.open(dir);
    const before = Math.floor(Date.now() / 1000);
    const s1 = ledger.appendEvent({ recordId: 'r1', actor: 'a', body: '1' });
    const s2 = ledger.appendEvent({ recordId: 'r2', actor: 'a', body: '2' });
    const s3 = ledger.appendEvent({ recordId: 'r1', actor: 'a', body: '3' });
    assert.deepEqual([s1, s2, s3], [1, 2, 3]);
    const credential = ledger.seal();
    const report = ledger.generateReport('r1');
    assert.ok(report.events[0].timestamp >= before);
    assert.ok(verifyReport(credential, 'r1', report));
    ledger.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('校验材料大小不超过64KiB', () => {
  const fx = buildFixture();
  try {
    const ledger = CustodyLedger.open(fx.dir);
    for (const rid of [...fx.recordIds, 'missing']) {
      const report = ledger.generateReport(rid);
      const proofBytes = Buffer.byteLength(JSON.stringify(report.proof));
      assert.ok(proofBytes <= 64 * 1024, `proof too large: ${proofBytes}`);
    }
    ledger.close();
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
