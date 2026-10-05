import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, openSync, readSync, writeSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustodyLedger } from '../src/ledger.js';
import { verifyReport } from '../src/report.js';
import { recordKey } from '../src/crypto.js';
import { compareBytes } from '../src/merkle.js';
import type { Credential } from '../src/types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'custody-tamper-'));
}

function flipByte(path: string, offset: number): void {
  const fd = openSync(path, 'r+');
  const buf = Buffer.alloc(1);
  readSync(fd, buf, 0, 1, offset);
  buf[0] ^= 0xff;
  writeSync(fd, buf, 0, 1, offset);
  closeSync(fd);
}

function fileSize(path: string): number {
  const fd = openSync(path, 'r');
  const size = fstatSync(fd).size;
  closeSync(fd);
  return size;
}

interface Setup {
  dir: string;
  credential: Credential;
}

const ALL_IDS = ['victim', 'other-0', 'other-1', 'other-2', 'other-3', 'other-4'];

/** 按键序找出排序后的第一条记录（封存文件中记录段的第一条）。 */
function firstSortedRecordId(): string {
  return ALL_IDS.slice().sort((a, b) => compareBytes(recordKey(a), recordKey(b)))[0];
}

/** 对每条记录生成报告并验真；返回 { 通过的记录集合 }，抛错的记录视为未通过。 */
function verifyAll(dir: string, credential: Credential): Set<string> {
  const ledger = CustodyLedger.open(dir);
  const ok = new Set<string>();
  for (const rid of ALL_IDS) {
    try {
      if (verifyReport(credential, rid, ledger.generateReport(rid))) ok.add(rid);
    } catch {
      // 自检发现账册被改，拒绝产出报告，视为未通过
    }
  }
  ledger.close();
  return ok;
}

/** 构造账册：victim 记录 20 条事件 + 其他记录若干。 */
function buildLedger(): Setup {
  const dir = tempDir();
  const ledger = CustodyLedger.open(dir);
  for (let i = 0; i < 20; i++) {
    ledger.appendEvent({ recordId: 'victim', timestamp: 1000 + i, actor: 'a', body: `victim-body-${i}` });
  }
  for (let i = 0; i < 30; i++) {
    ledger.appendEvent({ recordId: `other-${i % 5}`, timestamp: 1000 + i, actor: 'b', body: `other-${i}` });
  }
  const credential = ledger.seal();
  ledger.close();
  return { dir, credential };
}

test('events.log 被改动：目标记录报告无法通过验真', () => {
  const { dir, credential } = buildLedger();
  try {
    // 第一个事件（victim 的）正文区域翻一个字节
    flipByte(join(dir, 'events.log'), 30);
    const ledger = CustodyLedger.open(dir);
    let report = null;
    let threw = false;
    try {
      report = ledger.generateReport('victim');
    } catch {
      threw = true; // 自检发现账册被改，拒绝产出报告
    }
    ledger.close();
    if (!threw) {
      assert.ok(report !== null);
      assert.equal(verifyReport(credential, 'victim', report!), false, '被改账册产出的报告不应通过验真');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seal.bin 记录链头被改动：无法产出通过验真的报告', () => {
  const { dir, credential } = buildLedger();
  try {
    const sealPath = join(dir, 'seal.bin');
    const buf = readFileSync(sealPath);
    // 第一条记录（键序最小）的 head 区域：81 + ridLen(2) + rid + key(32) 之后
    const ridLen = buf.readUInt16LE(81);
    flipByte(sealPath, 81 + 2 + ridLen + 32 + 3);
    const ok = verifyAll(dir, credential);
    const victim0 = firstSortedRecordId();
    assert.equal(ok.has(victim0), false, '被改链头的记录不应通过验真');
    assert.ok(ok.size >= 1, '未受影响的记录仍应可验真');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seal.bin Merkle 层字节被改动：报告验真失败', () => {
  const { dir, credential } = buildLedger();
  try {
    const sealPath = join(dir, 'seal.bin');
    // 整个 Merkle 层区域全部翻转：任何记录的路径都必然读到被改节点
    const buf = readFileSync(sealPath);
    const recordCount = buf.readUInt32LE(77);
    let nodes = 0;
    for (let n = recordCount; n > 1; n = Math.ceil(n / 2)) nodes += n;
    if (recordCount >= 1) nodes += 1;
    const layersSize = nodes * 32;
    const layersStart = fileSize(sealPath) - layersSize;
    for (let off = layersStart; off < layersStart + layersSize; off += 7) {
      flipByte(sealPath, off);
    }
    const ledger = CustodyLedger.open(dir);
    const report = ledger.generateReport('victim');
    const empty = ledger.generateReport('ghost');
    ledger.close();
    assert.equal(verifyReport(credential, 'victim', report), false);
    assert.equal(verifyReport(credential, 'ghost', empty), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('seal.bin 序号表被改动：无法产出通过验真的报告', () => {
  const { dir, credential } = buildLedger();
  try {
    const sealPath = join(dir, 'seal.bin');
    const buf = readFileSync(sealPath);
    const recordCount = buf.readUInt32LE(77);
    // 计算记录段大小以定位序号表
    let o = 81;
    for (let i = 0; i < recordCount; i++) {
      const ridLen = buf.readUInt16LE(o);
      o += 2 + ridLen + 32 + 32 + 4 + 4;
    }
    flipByte(sealPath, o + 2); // 序号表第一个条目内（属于键序第一条记录）
    const ok = verifyAll(dir, credential);
    assert.equal(ok.has(firstSortedRecordId()), false, '序号被改的记录不应通过验真');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
