/** 解析后的 ELF32 program header 项（仅保留校验所需字段）。 */
export interface ProgramHeader {
  readonly type: number;
  readonly offset: number;
  readonly vaddr: number;
  readonly paddr: number;
  readonly filesz: number;
  readonly memsz: number;
}

export const ELF_HEADER_SIZE = 52;
export const PHDR_ENTRY_SIZE = 32;
export const PT_LOAD = 1;

const EI_CLASS = 4;
const EI_DATA = 5;
const EI_VERSION = 6;
const ELFCLASS32 = 1;
const ELFDATA2LSB = 1;
const EV_CURRENT = 1;
const ET_EXEC = 2;
const EM_ARM = 40;

export type ElfParseResult =
  | { ok: true; phdrs: ProgramHeader[] }
  | { ok: false; error: string };

/** 解析 ELF 头与 program header 表，校验标识、类型、版本与边界。 */
export function parseElf(bytes: Uint8Array): ElfParseResult {
  if (bytes.length < ELF_HEADER_SIZE) {
    return { ok: false, error: "file smaller than ELF header" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46
  ) {
    return { ok: false, error: "bad ELF magic" };
  }
  if (bytes[EI_CLASS] !== ELFCLASS32) {
    return { ok: false, error: "not ELF32" };
  }
  if (bytes[EI_DATA] !== ELFDATA2LSB) {
    return { ok: false, error: "not little-endian" };
  }
  if (bytes[EI_VERSION] !== EV_CURRENT) {
    return { ok: false, error: "bad ident version" };
  }
  if (view.getUint16(16, true) !== ET_EXEC) {
    return { ok: false, error: "not ET_EXEC" };
  }
  if (view.getUint16(18, true) !== EM_ARM) {
    return { ok: false, error: "not EM_ARM" };
  }
  if (view.getUint32(20, true) !== EV_CURRENT) {
    return { ok: false, error: "bad ELF version" };
  }
  const phoff = view.getUint32(28, true);
  if (view.getUint16(40, true) !== ELF_HEADER_SIZE) {
    return { ok: false, error: "bad ELF header size" };
  }
  if (view.getUint16(42, true) !== PHDR_ENTRY_SIZE) {
    return { ok: false, error: "bad program header entry size" };
  }
  const phnum = view.getUint16(44, true);
  // 数学整数运算：phoff、phnum 均小于 2^32，乘积与和在双精度内精确。
  const tableEnd = phoff + phnum * PHDR_ENTRY_SIZE;
  if (tableEnd > bytes.length) {
    return { ok: false, error: "program header table out of bounds" };
  }
  const phdrs: ProgramHeader[] = [];
  for (let i = 0; i < phnum; i++) {
    const base = phoff + i * PHDR_ENTRY_SIZE;
    phdrs.push({
      type: view.getUint32(base + 0, true),
      offset: view.getUint32(base + 4, true),
      vaddr: view.getUint32(base + 8, true),
      paddr: view.getUint32(base + 12, true),
      filesz: view.getUint32(base + 16, true),
      memsz: view.getUint32(base + 20, true),
    });
  }
  return { ok: true, phdrs };
}
