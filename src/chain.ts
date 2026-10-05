import { createHash } from "node:crypto";
import type { CustodyEvent } from "./types.js";

function sha256(...parts: Uint8Array[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

function u64be(value: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(value));
  return b;
}

function lengthPrefixed(text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
}

const TAG_ID = Buffer.from("EC1/ID", "utf8");
const TAG_EV = Buffer.from("EC1/EV", "utf8");
const TAG_CH = Buffer.from("EC1/CH", "utf8");
const TAG_LF = Buffer.from("EC1/LF", "utf8");
const TAG_EMPTY = Buffer.from("EC1/EMPTY", "utf8");

export const ZERO_HEAD: Buffer = Buffer.alloc(32, 0);

/** 记录标识的目录键：sha256(recordId)。 */
export function recordKey(recordId: string): Buffer {
  return sha256(TAG_ID, Buffer.from(recordId, "utf8"));
}

/** 事件的规范哈希（绑定记录键、seq、时间、操作者、正文）。 */
export function hashEvent(key: Buffer, event: CustodyEvent): Buffer {
  return sha256(
    TAG_EV,
    key,
    u64be(event.seq),
    u64be(event.timestamp),
    lengthPrefixed(event.operator),
    lengthPrefixed(event.body),
  );
}

/** 记录链推进：prev 为上一轮链头（首轮为全零）。 */
export function chainStep(prev: Buffer, eventHash: Buffer): Buffer {
  return sha256(TAG_CH, prev, eventHash);
}

/** 目录叶哈希：绑定 key、事件数、链头。 */
export function hashLeaf(key: Buffer, count: number, head: Buffer): Buffer {
  return sha256(TAG_LF, key, u64be(count), head);
}

/** 空账册（无任何记录）的目录根。 */
export function emptyRoot(): Buffer {
  return sha256(TAG_EMPTY);
}
