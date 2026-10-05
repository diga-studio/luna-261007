import { parseElf, PT_LOAD } from "./elf.js";
import type { AnalyzeResult, FlashImage, HardwareTarget } from "./types.js";

const UINT32_SPACE = 0x1_0000_0000;
export const MAX_READ_LENGTH = 64 * 1024;

type Source =
  | { readonly kind: "file"; readonly fileOffset: number }
  | { readonly kind: "zero" };

/** 已覆盖区间：flash 物理空间或 RAM 空间上的一段，及其初始化来源。 */
interface Interval {
  readonly start: number;
  readonly end: number;
  readonly source: Source;
}

class FirmwareImage implements FlashImage {
  constructor(
    readonly flashUsed: number,
    readonly ramUsed: number,
    readonly flashSize: number,
    readonly bytes: Uint8Array,
    readonly flashIntervals: Interval[],
  ) {}
}

function fail(error: string): AnalyzeResult {
  return { ok: false, error };
}

function isUint32Range(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= UINT32_SPACE;
}

/** 校验硬件配置自身的一致性（窗口不重叠、预算不超容量）。 */
function validateTarget(target: HardwareTarget): string | null {
  const { flashSize, flashAliases, ramBase, ramSize, flashBudget, ramBudget } =
    target;
  if (!Number.isInteger(flashSize) || flashSize < 0) return "bad flashSize";
  if (!Number.isInteger(ramSize) || ramSize < 0) return "bad ramSize";
  if (!isUint32Range(ramBase) || !isUint32Range(ramBase + ramSize)) {
    return "RAM window out of range";
  }
  if (
    !Number.isInteger(flashBudget) ||
    flashBudget < 0 ||
    flashBudget > flashSize
  ) {
    return "flash budget exceeds capacity";
  }
  if (!Number.isInteger(ramBudget) || ramBudget < 0 || ramBudget > ramSize) {
    return "RAM budget exceeds capacity";
  }
  const windows: Array<[number, number]> = [[ramBase, ramBase + ramSize]];
  for (const alias of flashAliases) {
    if (!isUint32Range(alias) || !isUint32Range(alias + flashSize)) {
      return "flash alias window out of range";
    }
    windows.push([alias, alias + flashSize]);
  }
  windows.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < windows.length; i++) {
    if (windows[i]![0] < windows[i - 1]![1]) return "address windows overlap";
  }
  return null;
}

/** 在有序不交叉区间表中定位：首个 end > start 的区间下标。 */
function lowerBound(intervals: Interval[], start: number): number {
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (intervals[mid]!.end <= start) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function rangeEquals(
  bytes: Uint8Array,
  offA: number,
  offB: number,
  length: number,
): boolean {
  for (let i = 0; i < length; i++) {
    if (bytes[offA + i] !== bytes[offB + i]) return false;
  }
  return true;
}

function rangeIsZero(bytes: Uint8Array, off: number, length: number): boolean {
  for (let i = 0; i < length; i++) {
    if (bytes[off + i] !== 0) return false;
  }
  return true;
}

/** 两个区间来源在重叠区 [s, e) 内的初始化字节是否一致。 */
function sourcesMatch(
  bytes: Uint8Array,
  a: Interval,
  b: Interval,
  s: number,
  e: number,
): boolean {
  const len = e - s;
  const srcA = a.source;
  const srcB = b.source;
  if (srcA.kind === "file" && srcB.kind === "file") {
    return rangeEquals(
      bytes,
      srcA.fileOffset + (s - a.start),
      srcB.fileOffset + (s - b.start),
      len,
    );
  }
  if (srcA.kind === "file") {
    return rangeIsZero(bytes, srcA.fileOffset + (s - a.start), len);
  }
  if (srcB.kind === "file") {
    return rangeIsZero(bytes, srcB.fileOffset + (s - b.start), len);
  }
  return true;
}

/**
 * 向有序不交叉区间表插入 [start, end)；与已有区间重叠的部分必须
 * 初始化字节一致，仅把空洞部分记入表中。返回 null 表示冲突。
 * 输出保持有序不交叉，且不展开任何大区间的内容。
 */
function mergeInterval(
  bytes: Uint8Array,
  intervals: Interval[],
  start: number,
  end: number,
  source: Source,
): Interval[] | null {
  if (start >= end) return intervals;
  const at = (pos: number): Source =>
    source.kind === "file"
      ? { kind: "file", fileOffset: source.fileOffset + (pos - start) }
      : { kind: "zero" };
  const added: Interval = { start, end, source };
  const result: Interval[] = [];
  let i = lowerBound(intervals, start);
  result.push(...intervals.slice(0, i));
  let cursor = start;
  while (cursor < end) {
    const existing = i < intervals.length ? intervals[i]! : undefined;
    if (existing === undefined || existing.start >= end) {
      result.push({ start: cursor, end, source: at(cursor) });
      break;
    }
    if (existing.start > cursor) {
      result.push({ start: cursor, end: existing.start, source: at(cursor) });
    }
    const ovStart = Math.max(cursor, existing.start);
    const ovEnd = Math.min(end, existing.end);
    if (!sourcesMatch(bytes, added, existing, ovStart, ovEnd)) return null;
    if (existing.end > end) {
      // existing 的剩余部分由后面的 slice 保留。
      break;
    }
    result.push(existing);
    cursor = existing.end;
    i++;
  }
  result.push(...intervals.slice(i));
  return result;
}

/** 验证固件 ELF 的内存映射，返回占用统计与可读取的映像。 */
export function analyzeFirmware(
  bytes: Uint8Array,
  target: HardwareTarget,
): AnalyzeResult {
  const configError = validateTarget(target);
  if (configError !== null) return fail(configError);

  const parsed = parseElf(bytes);
  if (!parsed.ok) return fail(parsed.error);

  const { flashSize, flashAliases, ramBase, ramSize } = target;
  const ramEnd = ramBase + ramSize;

  let flashIntervals: Interval[] = [];
  let ramIntervals: Interval[] = [];

  for (const ph of parsed.phdrs) {
    if (ph.type !== PT_LOAD) continue;
    if (ph.filesz > ph.memsz) return fail("p_filesz exceeds p_memsz");

    // 装载区：非空载荷必须完整落在一个 flash 别名窗口内。
    let loadPhys = -1;
    if (ph.filesz > 0) {
      if (ph.offset + ph.filesz > bytes.length) {
        return fail("load payload out of file bounds");
      }
      const loadEnd = ph.paddr + ph.filesz;
      for (const alias of flashAliases) {
        if (ph.paddr >= alias && loadEnd <= alias + flashSize) {
          loadPhys = ph.paddr - alias;
          break;
        }
      }
      if (loadPhys < 0) return fail("load range outside flash windows");
    }

    // 运行区：非空时须完整落在某个 flash 别名或 RAM 窗口内。
    if (ph.memsz > 0) {
      const vEnd = ph.vaddr + ph.memsz;
      let runPhys = -1;
      for (const alias of flashAliases) {
        if (ph.vaddr >= alias && vEnd <= alias + flashSize) {
          runPhys = ph.vaddr - alias;
          break;
        }
      }
      if (runPhys >= 0) {
        if (ph.memsz !== ph.filesz || runPhys !== loadPhys) {
          return fail("flash runtime range must match load range");
        }
      } else if (ph.vaddr >= ramBase && vEnd <= ramEnd) {
        const ramStart = ph.vaddr - ramBase;
        let merged = mergeInterval(bytes, ramIntervals, ramStart, ramStart + ph.filesz, {
          kind: "file",
          fileOffset: ph.offset,
        });
        if (merged === null) return fail("RAM payload conflict");
        merged = mergeInterval(bytes, merged, ramStart + ph.filesz, ramStart + ph.memsz, {
          kind: "zero",
        });
        if (merged === null) return fail("RAM zero-fill conflict");
        ramIntervals = merged;
      } else {
        return fail("runtime range outside all windows");
      }
    }

    if (ph.filesz > 0) {
      const merged = mergeInterval(bytes, flashIntervals, loadPhys, loadPhys + ph.filesz, {
        kind: "file",
        fileOffset: ph.offset,
      });
      if (merged === null) return fail("flash payload conflict");
      flashIntervals = merged;
    }
  }

  let flashUsed = 0;
  for (const iv of flashIntervals) flashUsed += iv.end - iv.start;
  let ramUsed = 0;
  for (const iv of ramIntervals) ramUsed += iv.end - iv.start;

  if (flashUsed > target.flashBudget) return fail("flash budget exceeded");
  if (ramUsed > target.ramBudget) return fail("RAM budget exceeded");

  const image = new FirmwareImage(flashUsed, ramUsed, flashSize, bytes, flashIntervals);
  return { ok: true, flashUsed, ramUsed, image };
}

/** 按物理 flash 偏移读取 [offset, offset + length)，未覆盖处填 0xFF。 */
export function readFlash(
  image: FlashImage,
  offset: number,
  length: number,
): Uint8Array {
  if (!(image instanceof FirmwareImage)) {
    throw new TypeError("not a verified firmware image");
  }
  if (!Number.isInteger(offset) || !Number.isInteger(length)) {
    throw new RangeError("offset and length must be integers");
  }
  if (offset < 0 || length < 0 || offset + length > image.flashSize) {
    throw new RangeError("read range out of flash bounds");
  }
  if (length > MAX_READ_LENGTH) {
    throw new RangeError("read length exceeds 64 KiB");
  }
  const out = new Uint8Array(length).fill(0xff);
  const end = offset + length;
  let i = lowerBound(image.flashIntervals, offset);
  while (i < image.flashIntervals.length) {
    const iv = image.flashIntervals[i]!;
    if (iv.start >= end) break;
    if (iv.source.kind !== "file") throw new Error("corrupt image");
    const s = Math.max(iv.start, offset);
    const e = Math.min(iv.end, end);
    out.set(
      image.bytes.subarray(
        iv.source.fileOffset + (s - iv.start),
        iv.source.fileOffset + (e - iv.start),
      ),
      s - offset,
    );
    i++;
  }
  return out;
}
