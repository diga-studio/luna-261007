import assert from 'node:assert/strict';
import test from 'node:test';
import { StlAnalyzer, StlFormatError, StlSizeError, type StlMetadata } from '../src/index.js';
import {
  analyze,
  analyzeError,
  chunkings,
  encode,
  expectBbox,
  makeAscii,
  makeBinary,
  makeTri,
  sha256Hex,
  type BboxExpect,
  type Tri,
} from './helpers.js';

function assertMetadata(meta: StlMetadata, expected: {
  format: 'binary' | 'ascii';
  triangleCount: number;
  sha256: string;
  bbox: BboxExpect | null;
}): void {
  assert.equal(meta.format, expected.format);
  assert.equal(meta.triangleCount, expected.triangleCount);
  assert.equal(meta.sha256, expected.sha256);
  if (expected.bbox === null) {
    assert.equal(meta.boundingBox, null);
    assert.equal(meta.dimensions, null);
    return;
  }
  assert.ok(meta.boundingBox);
  assert.ok(meta.dimensions);
  const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  const [minx, miny, minz] = expected.bbox.min;
  const [maxx, maxy, maxz] = expected.bbox.max;
  assert.ok(close(meta.boundingBox.min.x, minx), `min.x ${meta.boundingBox.min.x} != ${minx}`);
  assert.ok(close(meta.boundingBox.min.y, miny), `min.y`);
  assert.ok(close(meta.boundingBox.min.z, minz), `min.z`);
  assert.ok(close(meta.boundingBox.max.x, maxx), `max.x`);
  assert.ok(close(meta.boundingBox.max.y, maxy), `max.y`);
  assert.ok(close(meta.boundingBox.max.z, maxz), `max.z`);
  assert.ok(close(meta.dimensions.x, maxx - minx), 'dim.x');
  assert.ok(close(meta.dimensions.y, maxy - miny), 'dim.y');
  assert.ok(close(meta.dimensions.z, maxz - minz), 'dim.z');
}

/** 同一文件用三种切块处理，结果必须一致且符合预期。 */
function runValid(data: Uint8Array, expected: {
  format: 'binary' | 'ascii';
  triangleCount: number;
  bbox: BboxExpect | null;
}): void {
  let reference: StlMetadata | null = null;
  for (const { name, chunks } of chunkings(data)) {
    const meta = analyze(chunks);
    assertMetadata(meta, { ...expected, sha256: sha256Hex(data) });
    if (reference) assert.deepEqual(meta, reference, `chunking ${name} differs`);
    reference = meta;
  }
}

/** 同一文件用三种切块处理，都必须抛出同一类错误。 */
function runInvalid(data: Uint8Array, errorType: new (...args: never[]) => Error = StlFormatError): void {
  for (const { name, chunks } of chunkings(data)) {
    const err = analyzeError(chunks);
    assert.ok(err instanceof errorType, `chunking ${name}: expected ${errorType.name}, got ${err.name}: ${err.message}`);
  }
}

const triA = makeTri([[0, 0, 0], [25.4, 0, 0], [0, 25.4, 0]]);
const triB = makeTri([[-12.7, 5.08, 2.54], [50.8, 5.08, 2.54], [0, -25.4, 7.62]], [0, 1, 0]);

test('binary: 基本三角形', () => {
  const tris = [triA, triB];
  runValid(makeBinary(tris), { format: 'binary', triangleCount: 2, bbox: expectBbox(tris, { float32: true }) });
});

test('binary: 头部以 solid 开头仍按二进制处理', () => {
  const tris = [triA];
  const data = makeBinary(tris, { header: 'solid this is NOT an ascii file' });
  runValid(data, { format: 'binary', triangleCount: 1, bbox: expectBbox(tris, { float32: true }) });
});

test('binary: 零三角形包围盒为 null', () => {
  runValid(makeBinary([]), { format: 'binary', triangleCount: 0, bbox: null });
});

test('binary: 截断（缺失记录）无效', () => {
  const full = makeBinary([triA, triB]);
  runInvalid(full.subarray(0, full.length - 10));
});

test('binary: 声明数大于实际记录无效', () => {
  runInvalid(makeBinary([triA], { declaredCount: 2 }));
});

test('binary: 尾随多余字节无效', () => {
  runInvalid(makeBinary([triA], { trailing: new Uint8Array([0]) }));
});

test('binary: 非有限法线分量无效', () => {
  const bad = makeTri([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [NaN, 0, 1]);
  runInvalid(makeBinary([bad]));
});

test('binary: 非有限顶点分量无效', () => {
  const bad = makeTri([[0, 0, 0], [Infinity, 0, 0], [0, 1, 0]]);
  runInvalid(makeBinary([bad]));
});

test('ascii: 指数/负数/法线远离顶点', () => {
  const tri = makeTri(
    [[0, 0, 0], [2.54e1, -1.27E+1, 0], [0, 0, 5.08e0]],
    [1e30, -1e30, 0], // 法线远离顶点，不进包围盒
  );
  const text = makeAscii([{ name: 'demo', facets: [tri] }]);
  runValid(encode(text), { format: 'ascii', triangleCount: 1, bbox: expectBbox([tri]) });
});

test('ascii: 多 solid + 跨块 UTF-8 名称 + CRLF + 末尾 endsolid 无换行', () => {
  const name = 'é名🙂' + '长'.repeat(20); // 2/3/4 字节字符，单字节切块必跨 chunk
  const t1 = makeAscii([{ name, facets: [triA] }], { finalNewline: true });
  const t2raw = makeAscii([{ name: '第二段' + name, facets: [triB] }], { finalNewline: false });
  const data = encode(t1.replace(/\n/g, '\r\n') + t2raw);
  runValid(data, { format: 'ascii', triangleCount: 2, bbox: expectBbox([triA, triB]) });
});

test('ascii: 空名称 solid/endsolid 行（关键字后直接换行）', () => {
  runValid(encode('solid\nendsolid\n'), { format: 'ascii', triangleCount: 0, bbox: null });
  runValid(encode('solid\nendsolid'), { format: 'ascii', triangleCount: 0, bbox: null });
  const tri = triA;
  const text = 'solid\n' + makeAscii([{ facets: [tri] }]).slice('solid\n'.length);
  runValid(encode(text), { format: 'ascii', triangleCount: 1, bbox: expectBbox([tri]) });
});

test('ascii: 零 facet 包围盒为 null', () => {
  runValid(encode('solid empty\nendsolid\n'), { format: 'ascii', triangleCount: 0, bbox: null });
});

test('ascii: 末尾破坏关键字不得返回早先包围盒', () => {
  const good = makeAscii([
    { name: 'a', facets: [triA] },
    { name: 'b', facets: [triB] },
  ]);
  const broken = good.replace(/endsolid(?!.*endsolid)/s, 'endsoliX');
  assert.notEqual(broken, good);
  runInvalid(encode(broken));
});

test('ascii: 非有限数值（1e999）无效', () => {
  const text = makeAscii([{ facets: [makeTri([[0, 0, 0], [1e999, 0, 0], [0, 1, 0]])] }]);
  runInvalid(encode(text));
});

test('ascii: 超过 64 字节的 token 无效', () => {
  const longNum = '1'.repeat(65);
  const text = `solid\nfacet normal 0 0 1\nouter loop\nvertex ${longNum} 0 0\nvertex 0 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid\n`;
  runInvalid(encode(text));
});

test('ascii: 名称含非法 UTF-8 无效', () => {
  const prefix = encode('solid ');
  const badName = new Uint8Array([0xe5, 0x90, 0x28]); // 截断序列 + 非法后续字节
  const suffix = encode('\nendsolid\n');
  const data = new Uint8Array(prefix.length + badName.length + suffix.length);
  data.set(prefix, 0);
  data.set(badName, prefix.length);
  data.set(suffix, prefix.length + badName.length);
  runInvalid(data);
});

test('ascii: 关键字大写无效', () => {
  runInvalid(encode('Solid x\nendsolid\n'));
});

test('ascii: 缺少 endsolid 无效', () => {
  runInvalid(encode('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n'));
});

test('ascii: endsolid 后尾随垃圾无效', () => {
  runInvalid(encode('solid x\nendsolid x\ngarbage\n'));
});

test('ascii: endsolid 未独占一行无效', () => {
  runInvalid(encode('solid x\nendsolid y extra-token-after-name-is-fine\n trailing\n'));
  runInvalid(encode('solid\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet endsolid\n'));
});

test('ascii: facet 结构乱序无效', () => {
  runInvalid(encode('solid\nfacet normal 0 0 1\nvertex 0 0 0\nouter loop\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid\n'));
});

test('空输入无效', () => {
  runInvalid(new Uint8Array(0));
});

test('push 返回后调用方可复用 chunk 内存', () => {
  const tris = [triA, triB];
  const data = makeBinary(tris);
  const expected = analyze([data]);
  // 第二遍：每个 chunk push 后立即覆写为 0xFF
  const analyzer = new StlAnalyzer();
  const scratch = new Uint8Array(64);
  for (let pos = 0; pos < data.length; pos += scratch.length) {
    const n = Math.min(scratch.length, data.length - pos);
    scratch.set(data.subarray(pos, pos + n), 0);
    const view = scratch.subarray(0, n);
    analyzer.push(view);
    scratch.fill(0xff); // 调用方复用内存
  }
  assert.deepEqual(analyzer.finish(), expected);
});

test('超过 500 MiB 报大小错误（惰性生成，不预拼输入）', () => {
  function* chunks(): Generator<Uint8Array> {
    const MiB = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 501; i += 1) yield MiB;
  }
  const err = analyzeError(chunks());
  assert.ok(err instanceof StlSizeError, `expected StlSizeError, got ${err.name}`);
});
