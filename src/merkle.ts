import { HASH_SIZE, recordKey, zeroChain } from './crypto.js';
import { sha256, sha256Into, segOf } from './sha256.js';
import type { InclusionProof, ExclusionProof, MerklePathStep } from './types.js';

const TAG_LEAF = new TextEncoder().encode('custody/leaf/v1');
const TAG_NODE = new TextEncoder().encode('custody/node/v1');
const SEG_TAG_LEAF = segOf(TAG_LEAF);
const SEG_TAG_NODE = segOf(TAG_NODE);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** 比较 buf 中 [off, off+32) 与 32 字节键。 */
function compareKeyAt(buf: Uint8Array, off: number, key: Uint8Array): number {
  for (let i = 0; i < HASH_SIZE; i++) {
    if (buf[off + i] !== key[i]) return buf[off + i] - key[i];
  }
  return 0;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export { compareBytes, equalBytes };

/** 各层节点数（第 0 层为叶子层），奇数节点直接晋升。 */
export function layerSizes(leafCount: number): number[] {
  const sizes: number[] = [];
  let n = leafCount;
  while (n > 1) {
    sizes.push(n);
    n = Math.ceil(n / 2);
  }
  if (leafCount >= 1) sizes.push(1);
  return sizes;
}

/**
 * 排序叶子索引：记录键（H(recordId)）升序的叶子表，
 * 数据直接引用记录段缓冲（key 32B + head 32B 相邻）。要求键升序且无重复。
 * 记录段布局：ridLen u16 | rid | key 32 | head 32 | seqStart u32 | seqCount u32。
 */
export class LeafIndex {
  /** 第 i 个叶子的 key 位于 keyOffs[i]，head 位于 keyOffs[i]+32。 */
  readonly recBuf: Uint8Array;
  readonly keyOffs: Uint32Array;
  /** 第 i 个叶子的 ridLen 字段偏移（rid 紧随其后）。 */
  readonly ridOffs: Uint32Array;

  constructor(recBuf: Uint8Array, keyOffs: Uint32Array, ridOffs: Uint32Array) {
    this.recBuf = recBuf;
    this.keyOffs = keyOffs;
    this.ridOffs = ridOffs;
  }

  get leafCount(): number {
    return this.keyOffs.length;
  }

  /** 校验键升序（加载封存文件后调用）。 */
  checkSorted(): void {
    for (let i = 1; i < this.keyOffs.length; i++) {
      if (compareKeyAt(this.recBuf, this.keyOffs[i - 1], this.recBuf.subarray(this.keyOffs[i], this.keyOffs[i] + HASH_SIZE)) >= 0) {
        throw new Error('corrupt seal file: leaves not sorted');
      }
    }
  }

  /** 按 recordId 查找叶子下标；未找到返回 null。 */
  findIndex(recordId: string): number | null {
    const key = recordKey(recordId);
    let lo = 0;
    let hi = this.keyOffs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const cmp = compareKeyAt(this.recBuf, this.keyOffs[mid], key);
      if (cmp === 0) return mid;
      if (cmp < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** recordId 的插入位置（第一个键 >= H(recordId) 的下标）。 */
  insertionPoint(recordId: string): number {
    const key = recordKey(recordId);
    let lo = 0;
    let hi = this.keyOffs.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareKeyAt(this.recBuf, this.keyOffs[mid], key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** 第 i 个叶子的记录链头（新分配的 32 字节）。 */
  headAt(leafIndex: number): Uint8Array {
    const off = this.keyOffs[leafIndex] + HASH_SIZE;
    return this.recBuf.slice(off, off + HASH_SIZE);
  }

  /** 第 i 个叶子的 recordId（按需从记录段解码）。 */
  recordIdAt(leafIndex: number): string {
    const view = Buffer.from(this.recBuf.buffer, this.recBuf.byteOffset, this.recBuf.byteLength);
    const ridOff = this.ridOffs[leafIndex];
    const ridLen = view.readUInt16LE(ridOff);
    return view.toString('utf8', ridOff + 2, ridOff + 2 + ridLen);
  }

  seqStartAt(leafIndex: number): number {
    const off = this.keyOffs[leafIndex] + 2 * HASH_SIZE;
    return Buffer.from(this.recBuf.buffer, this.recBuf.byteOffset, this.recBuf.byteLength).readUInt32LE(off);
  }

  seqCountAt(leafIndex: number): number {
    const off = this.keyOffs[leafIndex] + 2 * HASH_SIZE + 4;
    return Buffer.from(this.recBuf.buffer, this.recBuf.byteOffset, this.recBuf.byteLength).readUInt32LE(off);
  }
}

/**
 * 由叶子索引构建 Merkle 树各层（仅在封存时执行）。
 * 返回拼接的层字节（layer0 || layer1 || ... || root）与根哈希。
 */
export function buildLayers(index: LeafIndex): { layersBlob: Uint8Array; root: Uint8Array } {
  const n = index.leafCount;
  if (n === 0) return { layersBlob: new Uint8Array(0), root: zeroChain() };
  const sizes = layerSizes(n);
  const totalNodes = sizes.reduce((a, b) => a + b, 0);
  const layersBlob = new Uint8Array(totalNodes * HASH_SIZE);
  const { recBuf, keyOffs } = index;
  for (let i = 0; i < n; i++) {
    const kOff = keyOffs[i];
    sha256Into(layersBlob, i * HASH_SIZE, [
      SEG_TAG_LEAF,
      [recBuf, kOff, HASH_SIZE],
      [recBuf, kOff + HASH_SIZE, HASH_SIZE],
    ]);
  }
  let srcOff = 0;
  let dstOff = sizes[0] * HASH_SIZE;
  for (let d = 0; d + 1 < sizes.length; d++) {
    const count = sizes[d];
    const nextCount = sizes[d + 1];
    for (let i = 0; i < nextCount; i++) {
      const lOff = srcOff + i * 2 * HASH_SIZE;
      if (i * 2 + 1 < count) {
        sha256Into(layersBlob, dstOff + i * HASH_SIZE, [
          SEG_TAG_NODE,
          [layersBlob, lOff, HASH_SIZE],
          [layersBlob, lOff + HASH_SIZE, HASH_SIZE],
        ]);
      } else {
        layersBlob.set(layersBlob.subarray(lOff, lOff + HASH_SIZE), dstOff + i * HASH_SIZE);
      }
    }
    srcOff = dstOff;
    dstOff += nextCount * HASH_SIZE;
  }
  const root = layersBlob.slice(layersBlob.length - HASH_SIZE);
  return { layersBlob, root };
}

/**
 * 从持久化的层字节中读取指定叶子的 Merkle 路径。
 * readAt(offset, length) 从 layersBlob 起点定位读取。
 */
export function readPath(
  readAt: (offset: number, length: number) => Uint8Array,
  leafCount: number,
  leafIndex: number,
): MerklePathStep[] {
  const sizes = layerSizes(leafCount);
  const path: MerklePathStep[] = [];
  let idx = leafIndex;
  let layerOff = 0;
  for (let d = 0; d + 1 < sizes.length; d++) {
    const count = sizes[d];
    if (idx % 2 === 1) {
      path.push({ hash: readAt(layerOff + (idx - 1) * HASH_SIZE, HASH_SIZE).slice(), siblingOnRight: false });
    } else if (idx + 1 < count) {
      path.push({ hash: readAt(layerOff + (idx + 1) * HASH_SIZE, HASH_SIZE).slice(), siblingOnRight: true });
    }
    layerOff += count * HASH_SIZE;
    idx = Math.floor(idx / 2);
  }
  return path;
}

/** 由叶子数据计算叶子哈希。 */
export function leafHash(key: Uint8Array, recordHead: Uint8Array): Uint8Array {
  return sha256(TAG_LEAF, key, recordHead);
}

/** 校验纳入证明：由叶子沿路径重算并与 root 比较。 */
export function verifyInclusion(
  root: Uint8Array,
  leafCount: number,
  leafIndex: number,
  key: Uint8Array,
  recordHead: Uint8Array,
  path: MerklePathStep[],
): boolean {
  if (!Number.isInteger(leafCount) || leafCount < 1) return false;
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafCount) return false;
  if (key.length !== HASH_SIZE || recordHead.length !== HASH_SIZE) return false;
  let h = leafHash(key, recordHead);
  let idx = leafIndex;
  let count = leafCount;
  let step = 0;
  while (count > 1) {
    if (idx % 2 === 1) {
      const s = path[step++];
      if (!s || s.siblingOnRight !== false || s.hash.length !== HASH_SIZE) return false;
      h = sha256(TAG_NODE, s.hash, h);
    } else if (idx + 1 < count) {
      const s = path[step++];
      if (!s || s.siblingOnRight !== true || s.hash.length !== HASH_SIZE) return false;
      h = sha256(TAG_NODE, h, s.hash);
    }
    idx = Math.floor(idx / 2);
    count = Math.ceil(count / 2);
  }
  if (step !== path.length) return false;
  return equalBytes(h, root);
}
