import { TYPE_SIZES } from "./types";
import type { IfdEntry, IfdNode } from "./types";

const TAG_EXIF_IFD = 0x8769;
const TAG_INTEROP_IFD = 0xa005;
const TAG_GPS_IFD = 0x8825;

/** Result of stripping GPS from one EXIF (TIFF) payload. */
export interface StripResult {
  /** New TIFF payload bytes, or null when nothing changed. */
  bytes: Uint8Array | null;
  changed: boolean;
}

interface TiffCtx {
  tiff: Uint8Array;
  little: boolean;
  hasGps: boolean;
}

function u16(ctx: TiffCtx, off: number): number {
  return ctx.little
    ? ctx.tiff[off] | (ctx.tiff[off + 1] << 8)
    : (ctx.tiff[off] << 8) | ctx.tiff[off + 1];
}

function u32(ctx: TiffCtx, off: number): number {
  return ctx.little
    ? (ctx.tiff[off] |
        (ctx.tiff[off + 1] << 8) |
        (ctx.tiff[off + 2] << 16) |
        (ctx.tiff[off + 3] << 24)) >>>
      0
    : ((ctx.tiff[off] << 24) |
        (ctx.tiff[off + 1] << 16) |
        (ctx.tiff[off + 2] << 8) |
        ctx.tiff[off + 3]) >>>
      0;
}

function parseIfd(ctx: TiffCtx, offset: number): IfdNode {
  if (offset + 2 > ctx.tiff.length) throw new Error("IFD offset out of range");
  const count = u16(ctx, offset);
  const tableEnd = offset + 2 + count * 12;
  if (tableEnd + 4 > ctx.tiff.length) throw new Error("IFD table out of range");
  const entries: IfdEntry[] = [];
  for (let i = 0; i < count; i++) {
    const eoff = offset + 2 + i * 12;
    const tag = u16(ctx, eoff);
    const type = u16(ctx, eoff + 2);
    const num = u32(ctx, eoff + 4);
    if (tag === TAG_GPS_IFD) {
      // Drop the GPSInfo pointer together with the whole subtree it
      // points to: the entry is not kept and the target is never read.
      ctx.hasGps = true;
      continue;
    }
    if (tag === TAG_EXIF_IFD || tag === TAG_INTEROP_IFD) {
      entries.push({
        tag,
        type,
        count: num,
        valueBytes: ctx.tiff.slice(eoff + 8, eoff + 12),
        inline: true,
        child: parseIfd(ctx, u32(ctx, eoff + 8)),
      });
      continue;
    }
    const unit = type >= 1 && type <= 12 ? TYPE_SIZES[type] : 0;
    const total = unit * num;
    if (total <= 4) {
      // Inline value (also the fallback for unknown types): keep the
      // original 4 bytes verbatim.
      entries.push({
        tag,
        type,
        count: num,
        valueBytes: ctx.tiff.slice(eoff + 8, eoff + 12),
        inline: true,
      });
    } else {
      const voff = u32(ctx, eoff + 8);
      if (voff + total > ctx.tiff.length) {
        throw new Error("value offset out of range");
      }
      entries.push({
        tag,
        type,
        count: num,
        valueBytes: ctx.tiff.slice(voff, voff + total),
        inline: false,
      });
    }
  }
  const nextOffset = u32(ctx, tableEnd);
  return { entries, next: nextOffset === 0 ? null : parseIfd(ctx, nextOffset) };
}

function serialize(root: IfdNode, little: boolean): Uint8Array {
  const offsets = new Map<IfdNode, number>();
  const valueOffsets = new Map<IfdEntry, number>();
  let cursor = 8;
  const layout = (node: IfdNode): void => {
    offsets.set(node, cursor);
    cursor += 2 + node.entries.length * 12 + 4;
    for (const entry of node.entries) {
      if (!entry.child && !entry.inline) {
        if (cursor & 1) cursor++;
        valueOffsets.set(entry, cursor);
        cursor += entry.valueBytes.length;
      }
    }
    for (const entry of node.entries) {
      if (entry.child) layout(entry.child);
    }
    if (node.next) layout(node.next);
  };
  layout(root);

  const out = new Uint8Array(cursor);
  const put16 = (off: number, v: number): void => {
    if (little) {
      out[off] = v & 0xff;
      out[off + 1] = (v >> 8) & 0xff;
    } else {
      out[off] = (v >> 8) & 0xff;
      out[off + 1] = v & 0xff;
    }
  };
  const put32 = (off: number, v: number): void => {
    if (little) {
      out[off] = v & 0xff;
      out[off + 1] = (v >> 8) & 0xff;
      out[off + 2] = (v >> 16) & 0xff;
      out[off + 3] = (v >> 24) & 0xff;
    } else {
      out[off] = (v >> 24) & 0xff;
      out[off + 1] = (v >> 16) & 0xff;
      out[off + 2] = (v >> 8) & 0xff;
      out[off + 3] = v & 0xff;
    }
  };
  if (little) {
    out[0] = 0x49;
    out[1] = 0x49;
  } else {
    out[0] = 0x4d;
    out[1] = 0x4d;
  }
  put16(2, 42);
  put32(4, 8);
  const write = (node: IfdNode): void => {
    const base = offsets.get(node)!;
    put16(base, node.entries.length);
    node.entries.forEach((entry, i) => {
      const eoff = base + 2 + i * 12;
      put16(eoff, entry.tag);
      put16(eoff + 2, entry.type);
      put32(eoff + 4, entry.count);
      if (entry.child) {
        put32(eoff + 8, offsets.get(entry.child)!);
      } else if (entry.inline) {
        out.set(entry.valueBytes, eoff + 8);
      } else {
        const voff = valueOffsets.get(entry)!;
        put32(eoff + 8, voff);
        out.set(entry.valueBytes, voff);
      }
    });
    put32(base + 2 + node.entries.length * 12, node.next ? offsets.get(node.next)! : 0);
    for (const entry of node.entries) {
      if (entry.child) write(entry.child);
    }
    if (node.next) write(node.next);
  };
  write(root);
  return out;
}

/** Parse the retained (non-GPS) directory graph of a TIFF payload. */
export function parseIfdGraph(tiff: Uint8Array): {
  root: IfdNode;
  hasGps: boolean;
} {
  if (tiff.length < 8) throw new Error("TIFF header too short");
  let little: boolean;
  if (tiff[0] === 0x49 && tiff[1] === 0x49) {
    little = true;
  } else if (tiff[0] === 0x4d && tiff[1] === 0x4d) {
    little = false;
  } else {
    throw new Error("unknown TIFF byte order");
  }
  const ctx: TiffCtx = { tiff, little, hasGps: false };
  if (u16(ctx, 2) !== 42) throw new Error("unsupported TIFF version");
  const root = parseIfd(ctx, u32(ctx, 4));
  return { root, hasGps: ctx.hasGps };
}

/** Remove the GPS IFD subtree from an EXIF TIFF payload
 *  (the bytes after the "Exif\0\0" header). Returns null bytes
 *  when the payload contains no GPS information. */
export function stripGpsFromTiff(tiff: Uint8Array): StripResult {
  let parsed: { root: IfdNode; hasGps: boolean };
  try {
    parsed = parseIfdGraph(tiff);
  } catch {
    return { bytes: null, changed: false };
  }
  if (!parsed.hasGps) return { bytes: null, changed: false };
  const little = tiff[0] === 0x49;
  return { bytes: serialize(parsed.root, little), changed: true };
}
