import { HASH_SIZE, eventCommitment, recordChainStep, recordKey, zeroChain } from './crypto.js';
import { encodeEvent } from './encoding.js';
import { compareBytes, equalBytes, verifyInclusion } from './merkle.js';
import type { Credential, CustodyEvent, CustodyReport, ExclusionProof } from './types.js';

export const CREDENTIAL_MAGIC = 0x43534331; // "CSC1"
export const CREDENTIAL_SIZE = 4 + 8 + HASH_SIZE + HASH_SIZE; // 76 字节，≤128
export const REPORT_VERSION = 1;

/** 从凭证字节中解析出的公开信息。 */
export interface CredentialInfo {
  eventCount: number;
  globalHead: Uint8Array;
  recordRoot: Uint8Array;
}

/** 生成封存凭证字节（≤128 字节）。 */
export function buildCredential(eventCount: number, globalHead: Uint8Array, recordRoot: Uint8Array): Credential {
  const buf = Buffer.allocUnsafe(CREDENTIAL_SIZE);
  buf.writeUInt32LE(CREDENTIAL_MAGIC, 0);
  buf.writeBigUInt64LE(BigInt(eventCount), 4);
  buf.set(globalHead, 12);
  buf.set(recordRoot, 44);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

export function parseCredential(credential: Credential): CredentialInfo {
  if (credential.length !== CREDENTIAL_SIZE) throw new Error('invalid credential size');
  const buf = Buffer.from(credential.buffer, credential.byteOffset, credential.byteLength);
  if (buf.readUInt32LE(0) !== CREDENTIAL_MAGIC) throw new Error('invalid credential magic');
  return {
    eventCount: Number(buf.readBigUInt64LE(4)),
    globalHead: credential.slice(12, 44),
    recordRoot: credential.slice(44, 76),
  };
}

function isValidEventShape(e: CustodyEvent): boolean {
  return Number.isInteger(e.seq) && e.seq >= 1
    && Number.isInteger(e.timestamp) && e.timestamp >= 0
    && typeof e.recordId === 'string'
    && typeof e.actor === 'string'
    && e.body instanceof Uint8Array;
}

/** 按 (timestamp, seq) 升序检查。 */
function isReportOrder(events: CustodyEvent[]): boolean {
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1];
    const b = events[i];
    if (a.timestamp > b.timestamp) return false;
    if (a.timestamp === b.timestamp && a.seq >= b.seq) return false;
  }
  return true;
}

/** 按追加顺序（seq 升序）重算记录保管链头。 */
function recordChainHead(events: CustodyEvent[]): Uint8Array {
  const bySeq = events.slice().sort((a, b) => a.seq - b.seq);
  let head = zeroChain();
  for (const e of bySeq) {
    head = recordChainStep(head, eventCommitment(encodeEvent(e)));
  }
  return head;
}

function verifyExclusion(recordRoot: Uint8Array, recordId: string, proof: ExclusionProof): boolean {
  const key = recordKey(recordId);
  const { leafCount, left, right } = proof;
  if (!Number.isInteger(leafCount) || leafCount < 0) return false;
  if (left === null && right === null) {
    return leafCount === 0 && equalBytes(recordRoot, zeroChain());
  }
  if (left !== null) {
    if (!verifyInclusion(recordRoot, leafCount, left.leafIndex, recordKey(left.recordId), left.recordHead, left.path)) return false;
    if (left.recordId === recordId) return false;
    if (compareBytes(recordKey(left.recordId), key) >= 0) return false;
  }
  if (right !== null) {
    if (!verifyInclusion(recordRoot, leafCount, right.leafIndex, recordKey(right.recordId), right.recordHead, right.path)) return false;
    if (right.recordId === recordId) return false;
    if (compareBytes(key, recordKey(right.recordId)) >= 0) return false;
  }
  if (left !== null && right !== null) return right.leafIndex === left.leafIndex + 1;
  if (left !== null) return left.leafIndex === leafCount - 1;
  return right!.leafIndex === 0;
}

/**
 * 独立验真：仅凭记录标识、可信凭证与报告判断完整可信。
 * 通过条件：内容准确、无遗漏、无额外事件、顺序正确、属于该凭证对应账册。
 */
export function verifyReport(credential: Credential, recordId: string, report: CustodyReport): boolean {
  let info: CredentialInfo;
  try {
    info = parseCredential(credential);
  } catch {
    return false;
  }
  if (report.version !== REPORT_VERSION) return false;
  if (report.recordId !== recordId) return false;
  const events = report.events;
  for (const e of events) {
    if (!isValidEventShape(e)) return false;
    if (e.recordId !== recordId) return false;
    if (e.seq > info.eventCount) return false;
  }
  // 序号唯一
  const seen = new Set<number>();
  for (const e of events) {
    if (seen.has(e.seq)) return false;
    seen.add(e.seq);
  }
  if (!isReportOrder(events)) return false;

  const proof = report.proof;
  if (proof.kind === 'inclusion') {
    if (events.length === 0) return false;
    if (!verifyInclusion(info.recordRoot, proof.leafCount, proof.leafIndex, recordKey(recordId), proof.recordHead, proof.path)) {
      return false;
    }
    return equalBytes(recordChainHead(events), proof.recordHead);
  }
  if (proof.kind === 'exclusion') {
    if (events.length !== 0) return false;
    return verifyExclusion(info.recordRoot, recordId, proof);
  }
  return false;
}
