import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256, sha256Into, segOf } from '../src/sha256.js';

test('纯TS SHA-256 与 node:crypto 一致（含多块、拼接、空输入）', () => {
  const cases: Uint8Array[][] = [
    [],
    [new Uint8Array(0)],
    [new TextEncoder().encode('abc')],
    [randomBytes(1)],
    [randomBytes(55)],
    [randomBytes(56)],
    [randomBytes(63)],
    [randomBytes(64)],
    [randomBytes(65)],
    [randomBytes(127)],
    [randomBytes(128)],
    [randomBytes(1000)],
    [randomBytes(30), randomBytes(40), randomBytes(58)],
    [randomBytes(64), randomBytes(64)],
    [randomBytes(13), randomBytes(7), randomBytes(3), randomBytes(100)],
  ];
  for (const parts of cases) {
    const h = createHash('sha256');
    for (const p of parts) h.update(p);
    const expected = new Uint8Array(h.digest());
    assert.deepEqual(sha256(...parts), expected, `mismatch for lengths ${parts.map(p => p.length)}`);
    const out = new Uint8Array(64);
    sha256Into(out, 17, parts.map(segOf));
    assert.deepEqual(out.subarray(17, 49), expected);
  }
});
