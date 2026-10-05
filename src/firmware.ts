import { FirmwareError } from "./types.js";
import type { FirmwareResult, HardwareTarget } from "./types.js";

const ELF_HEADER_SIZE = 52;
const PH_ENTRY_SIZE = 32;
const PT_LOAD = 1;
const ET_EXEC = 2;
const EM_ARM = 40;
const EV_CURRENT = 1;
const ADDR_SPACE = 0x1_0000_0000; // 2^32, exclusive upper bound for addresses
const MAX_READ_LENGTH = 64 * 1024;

/** Payload normalized to physical flash offsets, backed by file bytes. */
interface FlashLoad {
  readonly start: number; // physical flash offset, inclusive
  readonly end: number; // exclusive
  readonly fileOffset: number;
}

/** Runtime region in RAM, offsets relative to ramBase. */
interface RamRegion {
  readonly start: number;
  readonly end: number; // start + memsz
  readonly fileOffset: number;
  readonly filesz: number; // first filesz bytes come from the file, rest are zero
}

class AnalyzedFirmware implements FirmwareResult {
  readonly flashUsed: number;
  readonly ramUsed: number;
  readonly bytes: Uint8Array;
  readonly flashSize: number;
  readonly loads: FlashLoad[];

  constructor(
    flashUsed: number,
    ramUsed: number,
    bytes: Uint8Array,
    flashSize: number,
    loads: FlashLoad[],
  ) {
    this.flashUsed = flashUsed;
    this.ramUsed = ramUsed;
    this.bytes = bytes;
    this.flashSize = flashSize;
    this.loads = loads;
  }
}

function fail(message: string): never {
  throw new FirmwareError(message);
}

function isValidAddress(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= ADDR_SPACE;
}

function validateTarget(target: HardwareTarget): void {
  const { flashSize, flashAliases, ramBase, ramSize, flashBudget, ramBudget } = target;
  if (!Number.isSafeInteger(flashSize) || flashSize <= 0 || flashSize > ADDR_SPACE) {
    fail("invalid flashSize");
  }
  if (!Number.isSafeInteger(ramSize) || ramSize <= 0 || ramSize > ADDR_SPACE) {
    fail("invalid ramSize");
  }
  if (!isValidAddress(ramBase) || ramBase + ramSize > ADDR_SPACE) {
    fail("RAM window outside address space");
  }
  const windows: Array<[number, number]> = [[ramBase, ramBase + ramSize]];
  for (const alias of flashAliases) {
    if (!isValidAddress(alias) || alias + flashSize > ADDR_SPACE) {
      fail("flash alias window outside address space");
    }
    windows.push([alias, alias + flashSize]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < windows.length; i++) {
    if (windows[i]![0] < windows[i - 1]![1]) {
      fail("overlapping address windows in target configuration");
    }
  }
  if (!Number.isSafeInteger(flashBudget) || flashBudget < 0 || flashBudget > flashSize) {
    fail("flashBudget exceeds flash capacity");
  }
  if (!Number.isSafeInteger(ramBudget) || ramBudget < 0 || ramBudget > ramSize) {
    fail("ramBudget exceeds RAM capacity");
  }
}

/** Find the half-open window [base, base+size) fully containing [start, end). */
function findWindow(
  windows: Array<readonly [number, number]>,
  start: number,
  end: number,
): number | undefined {
  for (const [base, limit] of windows) {
    if (start >= base && end <= limit) {
      return base;
    }
  }
  return undefined;
}

function unionLength(intervals: Array<readonly [number, number]>): number {
  if (intervals.length === 0) {
    return 0;
  }
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    if (s > curEnd) {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  return total + (curEnd - curStart);
}

export function analyzeFirmware(bytes: Uint8Array, target: HardwareTarget): FirmwareResult {
  validateTarget(target);

  if (bytes.length < ELF_HEADER_SIZE) {
    fail("file smaller than ELF header");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 || // 'E'
    bytes[2] !== 0x4c || // 'L'
    bytes[3] !== 0x46 // 'F'
  ) {
    fail("bad ELF magic");
  }
  if (bytes[4] !== 1) fail("not ELFCLASS32");
  if (bytes[5] !== 1) fail("not little-endian");
  if (bytes[6] !== EV_CURRENT) fail("bad EI_VERSION");
  if (view.getUint16(16, true) !== ET_EXEC) fail("not ET_EXEC");
  if (view.getUint16(18, true) !== EM_ARM) fail("not EM_ARM");
  if (view.getUint32(20, true) !== EV_CURRENT) fail("bad e_version");
  if (view.getUint16(40, true) !== ELF_HEADER_SIZE) fail("bad e_ehsize");
  if (view.getUint16(42, true) !== PH_ENTRY_SIZE) fail("bad e_phentsize");

  const phoff = view.getUint32(28, true);
  const phnum = view.getUint16(44, true);
  if (phoff + phnum * PH_ENTRY_SIZE > bytes.length) {
    fail("program header table extends past end of file");
  }

  const flashWindows: Array<readonly [number, number]> = target.flashAliases.map((a) => [
    a,
    a + target.flashSize,
  ]);
  const ramWindow: readonly [number, number] = [target.ramBase, target.ramBase + target.ramSize];

  const loads: FlashLoad[] = [];
  const ramRegions: RamRegion[] = [];

  for (let i = 0; i < phnum; i++) {
    const ph = phoff + i * PH_ENTRY_SIZE;
    if (view.getUint32(ph + 0, true) !== PT_LOAD) {
      continue; // non-PT_LOAD payloads are never read
    }
    const pOffset = view.getUint32(ph + 4, true);
    const pVaddr = view.getUint32(ph + 8, true);
    const pPaddr = view.getUint32(ph + 12, true);
    const pFilesz = view.getUint32(ph + 16, true);
    const pMemsz = view.getUint32(ph + 20, true);

    if (pFilesz > pMemsz) {
      fail(`segment ${i}: p_filesz exceeds p_memsz`);
    }

    let loadPhysStart: number | undefined;
    if (pFilesz > 0) {
      if (pOffset + pFilesz > bytes.length) {
        fail(`segment ${i}: payload extends past end of file`);
      }
      const aliasBase = findWindow(flashWindows, pPaddr, pPaddr + pFilesz);
      if (aliasBase === undefined) {
        fail(`segment ${i}: load address range not contained in a flash window`);
      }
      loadPhysStart = pPaddr - aliasBase;
      loads.push({ start: loadPhysStart, end: loadPhysStart + pFilesz, fileOffset: pOffset });
    }

    if (pMemsz > 0) {
      const vEnd = pVaddr + pMemsz;
      const flashBase = findWindow(flashWindows, pVaddr, vEnd);
      if (flashBase !== undefined) {
        if (pMemsz !== pFilesz) {
          fail(`segment ${i}: flash runtime range requires p_memsz == p_filesz`);
        }
        if (loadPhysStart === undefined || pVaddr - flashBase !== loadPhysStart) {
          fail(`segment ${i}: flash runtime range maps to a different physical offset`);
        }
      } else if (pVaddr >= ramWindow[0] && vEnd <= ramWindow[1]) {
        ramRegions.push({
          start: pVaddr - target.ramBase,
          end: pVaddr - target.ramBase + pMemsz,
          fileOffset: pOffset,
          filesz: pFilesz,
        });
      } else {
        fail(`segment ${i}: runtime range not contained in any address window`);
      }
    }
  }

  checkFlashConflicts(bytes, loads);
  checkRamConflicts(bytes, ramRegions);

  const flashUsed = unionLength(loads.map((l) => [l.start, l.end] as const));
  const ramUsed = unionLength(ramRegions.map((r) => [r.start, r.end] as const));
  if (flashUsed > target.flashBudget) {
    fail("flash budget exceeded");
  }
  if (ramUsed > target.ramBudget) {
    fail("RAM budget exceeded");
  }

  return new AnalyzedFirmware(flashUsed, ramUsed, bytes, target.flashSize, loads);
}

function checkFlashConflicts(bytes: Uint8Array, loads: FlashLoad[]): void {
  const sorted = [...loads].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.start >= a.end) {
        break;
      }
      const ovStart = Math.max(a.start, b.start);
      const ovEnd = Math.min(a.end, b.end);
      for (let x = ovStart; x < ovEnd; x++) {
        if (bytes[a.fileOffset + (x - a.start)] !== bytes[b.fileOffset + (x - b.start)]) {
          fail("conflicting flash payloads in overlapping ranges");
        }
      }
    }
  }
}

/**
 * Effective byte of a RAM region at an absolute RAM offset:
 * file byte when inside the initialized prefix, zero afterwards.
 */
function ramByte(bytes: Uint8Array, region: RamRegion, at: number): number {
  const rel = at - region.start;
  return rel < region.filesz ? bytes[region.fileOffset + rel]! : 0;
}

function checkRamConflicts(bytes: Uint8Array, regions: RamRegion[]): void {
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.start >= a.end) {
        break;
      }
      const ovStart = Math.max(a.start, b.start);
      const ovEnd = Math.min(a.end, b.end);
      // Split the overlap at each region's initialized-prefix boundary so every
      // sub-range is uniformly file-backed or zero-filled on both sides. This
      // keeps work proportional to file sizes, never to declared BSS length.
      const cuts = [ovStart, a.start + a.filesz, b.start + b.filesz, ovEnd]
        .filter((v) => v > ovStart && v < ovEnd)
        .sort((x, y) => x - y);
      const edges = [ovStart, ...cuts, ovEnd];
      for (let k = 0; k + 1 < edges.length; k++) {
        const s = edges[k]!;
        const e = edges[k + 1]!;
        const aFile = s - a.start < a.filesz;
        const bFile = s - b.start < b.filesz;
        if (aFile && bFile) {
          for (let x = s; x < e; x++) {
            if (ramByte(bytes, a, x) !== ramByte(bytes, b, x)) {
              fail("conflicting RAM initialization in overlapping ranges");
            }
          }
        } else if (aFile || bFile) {
          const fileRegion = aFile ? a : b;
          for (let x = s; x < e; x++) {
            if (ramByte(bytes, fileRegion, x) !== 0) {
              fail("conflicting RAM initialization in overlapping ranges");
            }
          }
        }
      }
    }
  }
}

export function readFlash(result: FirmwareResult, offset: number, length: number): Uint8Array {
  if (!(result instanceof AnalyzedFirmware)) {
    fail("result was not produced by analyzeFirmware");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    fail("invalid read range");
  }
  if (length > MAX_READ_LENGTH) {
    fail("single read limited to 64 KiB");
  }
  if (offset + length > result.flashSize) {
    fail("read range past end of flash");
  }
  const out = new Uint8Array(length).fill(0xff);
  for (const load of result.loads) {
    const s = Math.max(load.start, offset);
    const e = Math.min(load.end, offset + length);
    if (s < e) {
      out.set(
        result.bytes.subarray(load.fileOffset + (s - load.start), load.fileOffset + (e - load.start)),
        s - offset,
      );
    }
  }
  return out;
}
