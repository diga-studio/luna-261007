import { createHash } from "node:crypto";
import { emptyRoot, hashLeaf } from "./chain.js";
import type { InclusionProof, LeafData } from "./types.js";

export interface DirectoryLeaf {
  key: Buffer;
  count: number;
  head: Buffer;
}

const TAG_ND = Buffer.from("EC1/ND", "utf8");

function hashNode(left: Uint8Array, right: Uint8Array): Buffer {
  const h = createHash("sha256");
  h.update(TAG_ND);
  h.update(left);
  h.update(right);
  return h.digest();
}

function leafHashOf(leaf: DirectoryLeaf): Buffer {
  return hashLeaf(leaf.key, leaf.count, leaf.head);
}

/** 由按键升序排列的叶计算 Merkle 根。奇数节点直接晋升上一层。 */
export function computeRoot(leaves: DirectoryLeaf[]): Buffer {
  if (leaves.length === 0) return emptyRoot();
  let level: Buffer[] = leaves.map(leafHashOf);
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : hashNode(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/** 为指定下标的叶生成包含证明（兄弟哈希自叶向根排列）。 */
export function proveInclusion(leaves: DirectoryLeaf[], index: number): InclusionProof {
  if (index < 0 || index >= leaves.length) throw new RangeError("leaf index out of range");
  const siblings: string[] = [];
  let level: Buffer[] = leaves.map(leafHashOf);
  let idx = index;
  while (level.length > 1) {
    const isOddLast = idx === level.length - 1 && level.length % 2 === 1;
    if (!isOddLast) {
      const sib = idx % 2 === 0 ? level[idx + 1]! : level[idx - 1]!;
      siblings.push(sib.toString("hex"));
    }
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      next.push(right === undefined ? left : hashNode(left, right));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return { leafIndex: index, leafCount: leaves.length, siblings };
}

/** 校验包含证明：leafHash 是否以该证明归于 root。 */
export function verifyInclusion(leafHash: Buffer, proof: InclusionProof, root: Buffer): boolean {
  const { leafIndex, leafCount, siblings } = proof;
  if (!Number.isInteger(leafIndex) || !Number.isInteger(leafCount)) return false;
  if (leafCount <= 0 || leafIndex < 0 || leafIndex >= leafCount) return false;
  let hash: Buffer = leafHash;
  let idx = leafIndex;
  let levelLen = leafCount;
  let s = 0;
  while (levelLen > 1) {
    const isOddLast = idx === levelLen - 1 && levelLen % 2 === 1;
    if (!isOddLast) {
      const sibHex = siblings[s++];
      if (sibHex === undefined || !/^[0-9a-f]{64}$/.test(sibHex)) return false;
      const sib = Buffer.from(sibHex, "hex");
      hash = idx % 2 === 0 ? hashNode(hash, sib) : hashNode(sib, hash);
    }
    idx = Math.floor(idx / 2);
    levelLen = Math.ceil(levelLen / 2);
  }
  if (s !== siblings.length) return false;
  return hash.equals(root);
}

/** 在按键升序的叶数组中二分查找 key；found 时 index 为命中位置，否则为插入位置。 */
export function locateKey(
  leaves: DirectoryLeaf[],
  key: Buffer,
): { found: boolean; index: number } {
  let lo = 0;
  let hi = leaves.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = Buffer.compare(leaves[mid]!.key, key);
    if (cmp === 0) return { found: true, index: mid };
    if (cmp < 0) lo = mid + 1;
    else hi = mid;
  }
  return { found: false, index: lo };
}

export function leafToData(leaf: DirectoryLeaf): LeafData {
  return {
    key: leaf.key.toString("hex"),
    count: leaf.count,
    head: leaf.head.toString("hex"),
  };
}
