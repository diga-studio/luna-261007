/** 手工构造 ELF32 字节，不依赖任何工具链，便于精确控制布局与边界。 */

export interface SegmentSpec {
  /** 缺省为 PT_LOAD(1)。 */
  type?: number;
  /** 载荷在文件中的偏移。 */
  offset: number;
  vaddr: number;
  paddr: number;
  filesz: number;
  memsz: number;
  /** 载荷内容，长度须等于 filesz；缺省为全零。 */
  data?: Uint8Array;
}

export interface ElfOptions {
  segments: SegmentSpec[];
  /** 强制文件总长度（可小于自然长度以模拟截断）。 */
  fileSize?: number;
  eiClass?: number;
  eiData?: number;
  eiVersion?: number;
  eType?: number;
  eMachine?: number;
  eVersion?: number;
  phoff?: number;
  ehsize?: number;
  phentsize?: number;
  /** 覆盖 e_phnum（可大于实际段数以模拟截断的段表）。 */
  phnum?: number;
  /** 破坏 magic 的某个字节。 */
  badMagic?: boolean;
}

export const ELF_HEADER_SIZE = 52;
export const PHDR_SIZE = 32;

export function buildElf(opts: ElfOptions): Uint8Array {
  const phoff = opts.phoff ?? ELF_HEADER_SIZE;
  const phnum = opts.phnum ?? opts.segments.length;
  let size = phoff + phnum * PHDR_SIZE;
  for (const seg of opts.segments) {
    if (seg.filesz > 0) size = Math.max(size, seg.offset + seg.filesz);
  }
  size = Math.max(size, ELF_HEADER_SIZE);
  const total = opts.fileSize ?? size;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  out[0] = 0x7f;
  out[1] = 0x45;
  out[2] = 0x4c;
  out[3] = 0x46;
  if (opts.badMagic === true) out[0] = 0x00;
  out[4] = opts.eiClass ?? 1;
  out[5] = opts.eiData ?? 1;
  out[6] = opts.eiVersion ?? 1;
  view.setUint16(16, opts.eType ?? 2, true);
  view.setUint16(18, opts.eMachine ?? 40, true);
  view.setUint32(20, opts.eVersion ?? 1, true);
  view.setUint32(28, phoff, true);
  view.setUint16(40, opts.ehsize ?? ELF_HEADER_SIZE, true);
  view.setUint16(42, opts.phentsize ?? PHDR_SIZE, true);
  view.setUint16(44, phnum, true);

  for (let i = 0; i < opts.segments.length; i++) {
    const seg = opts.segments[i]!;
    const base = phoff + i * PHDR_SIZE;
    if (base + PHDR_SIZE > total) break;
    view.setUint32(base + 0, seg.type ?? 1, true);
    view.setUint32(base + 4, seg.offset, true);
    view.setUint32(base + 8, seg.vaddr, true);
    view.setUint32(base + 12, seg.paddr, true);
    view.setUint32(base + 16, seg.filesz, true);
    view.setUint32(base + 20, seg.memsz, true);
    if (seg.filesz > 0 && seg.offset + seg.filesz <= total) {
      out.set(seg.data ?? new Uint8Array(seg.filesz), seg.offset);
    }
  }
  return out;
}

/** 生成确定性的伪随机字节序列，便于构造可区分的载荷。 */
export function pattern(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = (x >>> 16) & 0xff;
  }
  return out;
}
