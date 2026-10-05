import { createHash } from 'node:crypto';

/** 领域分离的哈希工具与链式承诺。 */

export const HASH_SIZE = 32;

const TAG_EVENT = new TextEncoder().encode('custody/event/v1');
const TAG_CHAIN = new TextEncoder().encode('custody/chain/v1');
const TAG_RECORD = new TextEncoder().encode('custody/record/v1');
const TAG_KEY = new TextEncoder().encode('custody/key/v1');
const TAG_GENESIS = new TextEncoder().encode('custody/genesis/v1');

function digest(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** 事件内容承诺 C = H(event)。 */
export function eventCommitment(encoded: Uint8Array): Uint8Array {
  return digest(TAG_EVENT, encoded);
}

/** 全局链：head = H(prev || C)。 */
export function chainStep(prev: Uint8Array, commitment: Uint8Array): Uint8Array {
  return digest(TAG_CHAIN, prev, commitment);
}

/** 记录内保管链：head = H(prev || C)。 */
export function recordChainStep(prev: Uint8Array, commitment: Uint8Array): Uint8Array {
  return digest(TAG_RECORD, prev, commitment);
}

/** 记录排序键：H(recordId)。 */
export function recordKey(recordId: string): Uint8Array {
  return digest(TAG_KEY, new TextEncoder().encode(recordId));
}

/** 空链起点。 */
export function zeroChain(): Uint8Array {
  return digest(TAG_GENESIS);
}
