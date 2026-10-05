import { chainStep, emptyRoot, hashEvent, hashLeaf, recordKey, ZERO_HEAD } from "./chain.js";
import { verifyInclusion } from "./merkle.js";
import type {
  Credential,
  CustodyReport,
  InclusionProof,
  LeafData,
  NonMembershipProof,
  ReportEvent,
} from "./types.js";

const CREDENTIAL_MAGIC = "454331"; // "EC1"
const CREDENTIAL_LENGTH = 3 + 8 + 32;
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 独立验真：仅凭可信凭证、目标记录标识和报告判断报告是否完整可信。
 * 不读取账册，不需要任何秘密密钥。
 */
export function verifyReport(
  credential: Credential,
  recordId: string,
  report: CustodyReport,
): boolean {
  try {
    return doVerify(credential, recordId, report);
  } catch {
    return false;
  }
}

function doVerify(credential: Credential, recordId: string, report: CustodyReport): boolean {
  const cred = Buffer.from(credential);
  if (cred.length !== CREDENTIAL_LENGTH) return false;
  if (cred.subarray(0, 3).toString("hex") !== CREDENTIAL_MAGIC) return false;
  const totalCount = Number(cred.readBigUInt64BE(3));
  const root = cred.subarray(11, 43);

  if (report === null || typeof report !== "object") return false;
  if (report.version !== 1) return false;
  if (report.recordId !== recordId) return false;
  if (!Array.isArray(report.events)) return false;
  if (report.proof === null || typeof report.proof !== "object") return false;

  for (const ev of report.events) {
    if (!validEvent(ev)) return false;
  }
  if (!sortedByTimeThenSeq(report.events)) return false;
  if (!uniqueSeqs(report.events)) return false;
  if (report.events.length > totalCount) return false;

  const key = recordKey(recordId);
  const head = computeChainHead(key, recordId, report.events);
  const count = report.events.length;

  if (count > 0) {
    const inclusion = report.proof.inclusion;
    if (inclusion === null || inclusion === undefined) return false;
    if (report.proof.nonMembership !== null) return false;
    if (!leafMatches(inclusion.leaf, key, count, head)) return false;
    return verifyInclusion(hashLeaf(key, count, head), inclusion.proof, root);
  }

  const nm = report.proof.nonMembership;
  if (nm === null || nm === undefined) return false;
  if (report.proof.inclusion !== null) return false;
  return verifyNonMembership(nm, key, root);
}

function validEvent(ev: ReportEvent): boolean {
  if (ev === null || typeof ev !== "object") return false;
  if (!Number.isSafeInteger(ev.seq) || ev.seq <= 0) return false;
  if (!Number.isSafeInteger(ev.timestamp) || ev.timestamp < 0) return false;
  if (typeof ev.operator !== "string") return false;
  if (typeof ev.body !== "string") return false;
  return true;
}

function sortedByTimeThenSeq(events: ReportEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]!;
    const cur = events[i]!;
    if (cur.timestamp < prev.timestamp) return false;
    if (cur.timestamp === prev.timestamp && cur.seq <= prev.seq) return false;
  }
  return true;
}

function uniqueSeqs(events: ReportEvent[]): boolean {
  const seen = new Set<number>();
  for (const ev of events) {
    if (seen.has(ev.seq)) return false;
    seen.add(ev.seq);
  }
  return true;
}

function computeChainHead(key: Buffer, recordId: string, events: ReportEvent[]): Buffer {
  const bySeq = [...events].sort((a, b) => a.seq - b.seq);
  let head: Buffer = ZERO_HEAD;
  for (const ev of bySeq) {
    head = chainStep(
      head,
      hashEvent(key, {
        seq: ev.seq,
        recordId,
        timestamp: ev.timestamp,
        operator: ev.operator,
        body: ev.body,
      }),
    );
  }
  return head;
}

function leafMatches(leaf: LeafData, key: Buffer, count: number, head: Buffer): boolean {
  if (leaf === null || typeof leaf !== "object") return false;
  if (!HEX64.test(leaf.key) || !HEX64.test(leaf.head)) return false;
  if (!Number.isSafeInteger(leaf.count) || leaf.count <= 0) return false;
  return (
    leaf.key === key.toString("hex") &&
    leaf.count === count &&
    leaf.head === head.toString("hex")
  );
}

function verifyNonMembership(nm: NonMembershipProof, key: Buffer, root: Buffer): boolean {
  if (!Number.isSafeInteger(nm.leafCount) || nm.leafCount < 0) return false;
  const keyHex = key.toString("hex");

  if (nm.leafCount === 0) {
    return nm.left === null && nm.right === null && root.equals(emptyRoot());
  }

  if (nm.left === null && nm.right === null) return false;

  let leftIndex = -1;
  let rightIndex = -1;

  if (nm.left !== null) {
    if (!checkNeighbor(nm.left.leaf, nm.left.proof, nm.leafCount, root)) return false;
    if (!(nm.left.leaf.key < keyHex)) return false;
    leftIndex = nm.left.proof.leafIndex;
  }
  if (nm.right !== null) {
    if (!checkNeighbor(nm.right.leaf, nm.right.proof, nm.leafCount, root)) return false;
    if (!(keyHex < nm.right.leaf.key)) return false;
    rightIndex = nm.right.proof.leafIndex;
  }

  if (nm.left !== null && nm.right !== null) {
    return rightIndex === leftIndex + 1;
  }
  if (nm.left !== null) {
    return leftIndex === nm.leafCount - 1;
  }
  return rightIndex === 0;
}

function checkNeighbor(
  leaf: LeafData,
  proof: InclusionProof,
  leafCount: number,
  root: Buffer,
): boolean {
  if (leaf === null || typeof leaf !== "object") return false;
  if (!HEX64.test(leaf.key) || !HEX64.test(leaf.head)) return false;
  if (!Number.isSafeInteger(leaf.count) || leaf.count <= 0) return false;
  if (proof === null || typeof proof !== "object") return false;
  if (proof.leafCount !== leafCount) return false;
  const leafHash = hashLeaf(
    Buffer.from(leaf.key, "hex"),
    leaf.count,
    Buffer.from(leaf.head, "hex"),
  );
  return verifyInclusion(leafHash, proof, root);
}
