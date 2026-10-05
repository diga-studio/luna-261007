/** Minimal hand-rolled ELF32 builder for tests (no toolchain involved). */

export interface SegmentSpec {
  type?: number; // defaults to PT_LOAD
  vaddr: number;
  paddr: number;
  filesz: number;
  memsz: number;
  /** Payload bytes; defaults to deterministic pattern derived from seed. */
  data?: Uint8Array;
}

export interface ElfOptions {
  segments: SegmentSpec[];
  /** Extra bytes appended after the program header table, before payloads. */
  padBeforeData?: number;
  /** Override fields for malformed-file tests. */
  ehdrSize?: number;
  phentSize?: number;
  phnumOverride?: number;
  machine?: number;
  type?: number;
  eiClass?: number;
  eiData?: number;
  eiVersion?: number;
  eVersion?: number;
  /** Truncate the final file to this many bytes. */
  truncateTo?: number;
}

const EHDR = 52;
const PHENT = 32;

export function fillPattern(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}

export function buildElf(opts: ElfOptions): Uint8Array {
  const phnum = opts.phnumOverride ?? opts.segments.length;
  const phoff = EHDR;
  let dataCursor = phoff + opts.segments.length * PHENT + (opts.padBeforeData ?? 0);

  const offsets: number[] = [];
  const payloads: Uint8Array[] = [];
  for (const seg of opts.segments) {
    const data = seg.data ?? fillPattern(0x1234 + offsets.length * 7, seg.filesz);
    if (data.length !== seg.filesz) {
      throw new Error("data length must equal filesz");
    }
    offsets.push(dataCursor);
    payloads.push(data);
    dataCursor += data.length;
  }

  let total = dataCursor;
  if (opts.truncateTo !== undefined) {
    total = opts.truncateTo;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out[0] = 0x7f;
  out[1] = 0x45;
  out[2] = 0x4c;
  out[3] = 0x46;
  out[4] = opts.eiClass ?? 1;
  out[5] = opts.eiData ?? 1;
  out[6] = opts.eiVersion ?? 1;
  view.setUint16(16, opts.type ?? 2, true); // ET_EXEC
  view.setUint16(18, opts.machine ?? 40, true); // EM_ARM
  view.setUint32(20, opts.eVersion ?? 1, true);
  view.setUint32(28, phoff, true);
  view.setUint16(40, opts.ehdrSize ?? EHDR, true);
  view.setUint16(42, opts.phentSize ?? PHENT, true);
  view.setUint16(44, phnum, true);

  for (let i = 0; i < opts.segments.length; i++) {
    const seg = opts.segments[i]!;
    const ph = phoff + i * PHENT;
    if (ph + PHENT > total) break; // truncated table
    view.setUint32(ph + 0, seg.type ?? 1, true);
    view.setUint32(ph + 4, offsets[i]!, true);
    view.setUint32(ph + 8, seg.vaddr, true);
    view.setUint32(ph + 12, seg.paddr, true);
    view.setUint32(ph + 16, seg.filesz, true);
    view.setUint32(ph + 20, seg.memsz, true);
    if (ph + PHENT <= total) {
      const payload = payloads[i]!;
      const off = offsets[i]!;
      if (off + payload.length <= total) {
        out.set(payload, off);
      } else if (off < total) {
        out.set(payload.subarray(0, total - off), off);
      }
    }
  }
  return out;
}
