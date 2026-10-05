/**
 * 纯 TS 实现的 SHA-256（FIPS 180-4），支持调用方提供输出缓冲，
 * 用于 Merkle 树构建等大批量哈希场景，避免海量临时 Buffer 驻留内存。
 * 正确性由测试与 node:crypto 交叉校验。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const W = new Uint32Array(64);
const HSTATE = new Uint32Array(8);
// 单次调用的拼接暂存：我们的输入都很短（≤160B），按块流式处理即可
const BLOCK = new Uint8Array(64);
const BLOCK_VIEW = new DataView(BLOCK.buffer);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function compress(): void {
  for (let t = 0; t < 16; t++) W[t] = BLOCK_VIEW.getUint32(t * 4, false);
  for (let t = 16; t < 64; t++) {
    const x = W[t - 15];
    const y = W[t - 2];
    W[t] = (W[t - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + W[t - 7]
      + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) | 0;
  }
  let a = HSTATE[0], b = HSTATE[1], c = HSTATE[2], d = HSTATE[3];
  let e = HSTATE[4], f = HSTATE[5], g = HSTATE[6], h = HSTATE[7];
  for (let t = 0; t < 64; t++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + s1 + ch + K[t] + W[t]) | 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0;
    d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  HSTATE[0] = (HSTATE[0] + a) | 0;
  HSTATE[1] = (HSTATE[1] + b) | 0;
  HSTATE[2] = (HSTATE[2] + c) | 0;
  HSTATE[3] = (HSTATE[3] + d) | 0;
  HSTATE[4] = (HSTATE[4] + e) | 0;
  HSTATE[5] = (HSTATE[5] + f) | 0;
  HSTATE[6] = (HSTATE[6] + g) | 0;
  HSTATE[7] = (HSTATE[7] + h) | 0;
}

/** 字节段：[缓冲, 起始偏移, 长度]。直接引用底层缓冲，避免包装对象分配。 */
export type Seg = readonly [Uint8Array, number, number];

export function segOf(buf: Uint8Array): Seg {
  return [buf, 0, buf.length];
}

/**
 * 计算各字节段依次拼接的 SHA-256，写入 out 的 outOffset 处（32 字节）。
 * 非线程安全（共享暂存区），Node 单线程下安全；调用方不得重入。
 */
export function sha256Into(out: Uint8Array, outOffset: number, segs: readonly Seg[]): void {
  HSTATE.set(H0);
  let total = 0;
  let used = 0; // BLOCK 中已填充字节
  for (const [buf, off, len] of segs) {
    total += len;
    let p = off;
    const end = off + len;
    while (p < end) {
      const n = Math.min(64 - used, end - p);
      BLOCK.set(buf.subarray(p, p + n), used);
      used += n;
      p += n;
      if (used === 64) {
        compress();
        used = 0;
      }
    }
  }
  // 结尾填充
  BLOCK[used++] = 0x80;
  if (used > 56) {
    BLOCK.fill(0, used, 64);
    compress();
    used = 0;
  }
  BLOCK.fill(0, used, 56);
  const bitLen = total * 8;
  BLOCK_VIEW.setUint32(56, Math.floor(bitLen / 0x100000000), false);
  BLOCK_VIEW.setUint32(60, bitLen >>> 0, false);
  compress();
  for (let i = 0; i < 8; i++) {
    out[outOffset + i * 4] = HSTATE[i] >>> 24;
    out[outOffset + i * 4 + 1] = HSTATE[i] >>> 16;
    out[outOffset + i * 4 + 2] = HSTATE[i] >>> 8;
    out[outOffset + i * 4 + 3] = HSTATE[i];
  }
}

/** 便捷形式：返回新分配的 32 字节哈希。 */
export function sha256(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(32);
  sha256Into(out, 0, parts.map(segOf));
  return out;
}
