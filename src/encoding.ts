import type { CustodyEvent } from './types.js';

const U32 = 4;
const U64 = 8;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** 事件二进制编码：totalLen u32 | seq u64 | timestamp u64 | ridLen u32 rid | actorLen u32 actor | bodyLen u32 body */
export function encodeEvent(event: CustodyEvent): Uint8Array {
  const rid = textEncoder.encode(event.recordId);
  const actor = textEncoder.encode(event.actor);
  const total = U32 + U64 + U64 + U32 + rid.length + U32 + actor.length + U32 + event.body.length;
  const buf = Buffer.allocUnsafe(total);
  let o = 0;
  buf.writeUInt32LE(total, o); o += U32;
  buf.writeBigUInt64LE(BigInt(event.seq), o); o += U64;
  buf.writeBigUInt64LE(BigInt(event.timestamp), o); o += U64;
  buf.writeUInt32LE(rid.length, o); o += U32;
  buf.set(rid, o); o += rid.length;
  buf.writeUInt32LE(actor.length, o); o += U32;
  buf.set(actor, o); o += actor.length;
  buf.writeUInt32LE(event.body.length, o); o += U32;
  buf.set(event.body, o);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** 从字节流偏移处解码一个事件，返回事件与新偏移。 */
export function decodeEvent(buf: Uint8Array, offset: number): { event: CustodyEvent; nextOffset: number } {
  const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = offset;
  const total = view.readUInt32LE(o); o += U32;
  const seq = Number(view.readBigUInt64LE(o)); o += U64;
  const timestamp = Number(view.readBigUInt64LE(o)); o += U64;
  const ridLen = view.readUInt32LE(o); o += U32;
  const recordId = textDecoder.decode(buf.subarray(o, o + ridLen)); o += ridLen;
  const actorLen = view.readUInt32LE(o); o += U32;
  const actor = textDecoder.decode(buf.subarray(o, o + actorLen)); o += actorLen;
  const bodyLen = view.readUInt32LE(o); o += U32;
  const body = new Uint8Array(buf.subarray(o, o + bodyLen)); o += bodyLen;
  if (o - offset !== total) throw new Error('corrupt event record');
  return { event: { seq, recordId, timestamp, actor, body }, nextOffset: o };
}

/** 编码后的事件长度（字节）。 */
export function encodedEventSize(event: CustodyEvent): number {
  return U32 + U64 + U64 + U32 + textEncoder.encode(event.recordId).length
    + U32 + textEncoder.encode(event.actor).length + U32 + event.body.length;
}
