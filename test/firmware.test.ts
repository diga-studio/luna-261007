import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFirmware, readFlash, FirmwareError } from "../src/index.js";
import type { HardwareTarget } from "../src/index.js";
import { buildElf, fillPattern } from "./elf.js";

const FLASH_SIZE = 0x10000;
const ALIAS_A = 0x08000000;
const ALIAS_B = 0x10000000;
const RAM_BASE = 0x20000000;
const RAM_SIZE = 0x10000000; // 256 MiB declared RAM

function makeTarget(overrides: Partial<HardwareTarget> = {}): HardwareTarget {
  return {
    flashSize: FLASH_SIZE,
    flashAliases: [ALIAS_A, ALIAS_B],
    ramBase: RAM_BASE,
    ramSize: RAM_SIZE,
    flashBudget: FLASH_SIZE,
    ramBudget: RAM_SIZE,
    ...overrides,
  };
}

function assertRejected(bytes: Uint8Array, target: HardwareTarget): void {
  assert.throws(() => analyzeFirmware(bytes, target), FirmwareError);
}

// ---------- flash alias overlap ----------

function aliasOverlapSegments(overlapByte?: number) {
  const d1 = fillPattern(11, 0x100);
  const d2 = fillPattern(22, 0x100);
  // d2 overlaps d1 on physical [0x80, 0x100): d2[0..0x80) must equal d1[0x80..0x100)
  d2.set(d1.subarray(0x80, 0x100), 0);
  if (overlapByte !== undefined) {
    d2[0x10] = overlapByte; // inside the overlap
  }
  return [
    { vaddr: ALIAS_A, paddr: ALIAS_A, filesz: 0x100, memsz: 0x100, data: d1 },
    { vaddr: ALIAS_B + 0x80, paddr: ALIAS_B + 0x80, filesz: 0x100, memsz: 0x100, data: d2 },
  ];
}

test("identical overlapping payloads across flash aliases are accepted and counted once", () => {
  const segs = aliasOverlapSegments();
  const result = analyzeFirmware(buildElf({ segments: segs }), makeTarget());
  // union of physical [0, 0x100) and [0x80, 0x180)
  assert.equal(result.flashUsed, 0x180);
  assert.equal(result.ramUsed, 0);
  const d1 = segs[0]!.data!;
  const d2 = segs[1]!.data!;
  const read = readFlash(result, 0, 0x180);
  assert.deepEqual([...read.subarray(0, 0x100)], [...d1]);
  assert.deepEqual([...read.subarray(0x100, 0x180)], [...d2.subarray(0x80)]);
});

test("one differing byte in the alias overlap is rejected", () => {
  const d1byte = fillPattern(11, 0x100)[0x90]!;
  const segs = aliasOverlapSegments(d1byte ^ 0xff);
  assertRejected(buildElf({ segments: segs }), makeTarget());
});

test("swapping program header order changes nothing", () => {
  const segs = aliasOverlapSegments();
  const a = analyzeFirmware(buildElf({ segments: segs }), makeTarget());
  const b = analyzeFirmware(buildElf({ segments: [...segs].reverse() }), makeTarget());
  assert.equal(a.flashUsed, b.flashUsed);
  assert.equal(a.ramUsed, b.ramUsed);
  assert.deepEqual(readFlash(a, 0, 0x180), readFlash(b, 0, 0x180));
});

// ---------- RAM init vs huge BSS tail ----------

const BSS_SIZE = 0x8000000; // 128 MiB BSS, far larger than the file

function ramBssSegments(tailByte: number) {
  const init = fillPattern(33, 0x40);
  init.fill(0, 0x20, 0x40); // overlap with BSS must be zero
  init[0x30] = tailByte; // inside the BSS overlap
  return [
    { vaddr: RAM_BASE + 0x1000, paddr: ALIAS_A + 0x2000, filesz: 0x40, memsz: 0x40, data: init },
    { vaddr: RAM_BASE + 0x1020, paddr: 0xdeadbeef, filesz: 0, memsz: BSS_SIZE },
  ];
}

test("RAM init segment overlapping a huge BSS tail with zero bytes is accepted", () => {
  const result = analyzeFirmware(buildElf({ segments: ramBssSegments(0) }), makeTarget());
  // union of RAM [0x1000, 0x1040) and [0x1020, 0x1020 + BSS_SIZE)
  assert.equal(result.ramUsed, BSS_SIZE + 0x20);
  assert.equal(result.flashUsed, 0x40);
});

test("non-zero init byte inside the BSS overlap is rejected", () => {
  assertRejected(buildElf({ segments: ramBssSegments(1) }), makeTarget());
});

test("budgets are enforced against normalized usage", () => {
  const ok = ramBssSegments(0);
  assertRejected(buildElf({ segments: ok }), makeTarget({ ramBudget: BSS_SIZE + 0x1f }));
  assertRejected(buildElf({ segments: ok }), makeTarget({ flashBudget: 0x3f }));
  const r = analyzeFirmware(
    buildElf({ segments: ok }),
    makeTarget({ ramBudget: BSS_SIZE + 0x20, flashBudget: 0x40 }),
  );
  assert.equal(r.flashUsed, 0x40);
});

test("flash holes read as 0xFF around a payload", () => {
  const result = analyzeFirmware(buildElf({ segments: ramBssSegments(0) }), makeTarget());
  const read = readFlash(result, 0x1ff0, 0x40); // hole, payload at [0x2000, 0x2040), hole
  assert.ok(read.subarray(0, 0x10).every((b) => b === 0xff));
  const payload = readFlash(result, 0x2000, 0x40);
  const init = fillPattern(33, 0x40);
  init.fill(0, 0x20, 0x40);
  assert.deepEqual([...payload], [...init]);
  const hole = readFlash(result, 0x8000, 0x100);
  assert.ok(hole.every((b) => b === 0xff));
});

// ---------- address window edges, wraparound, truncation ----------

test("segment ending exactly at 2^32 is accepted, crossing or wrapping is rejected", () => {
  const target = makeTarget({
    flashSize: 0x10000,
    flashAliases: [0xffff0000],
    flashBudget: 0x10000,
  });
  const edge = [{ vaddr: 0xfffff000, paddr: 0xfffff000, filesz: 0x1000, memsz: 0x1000 }];
  const r = analyzeFirmware(buildElf({ segments: edge }), target);
  assert.equal(r.flashUsed, 0x1000);

  const crossing = [{ vaddr: 0xfffff001, paddr: 0xfffff001, filesz: 0x1000, memsz: 0x1000 }];
  assertRejected(buildElf({ segments: crossing }), target);

  // paddr + filesz = 2^32 + 0x10: wraps in u32 arithmetic, must be rejected
  const wrap = [{ vaddr: 0xfffffff0, paddr: 0xfffffff0, filesz: 0x20, memsz: 0x20 }];
  assertRejected(buildElf({ segments: wrap }), target);
});

test("RAM runtime range edges at the window end", () => {
  const target = makeTarget();
  const exact = [
    { vaddr: RAM_BASE + RAM_SIZE - 0x10, paddr: ALIAS_A, filesz: 0x10, memsz: 0x10 },
  ];
  const r = analyzeFirmware(buildElf({ segments: exact }), target);
  assert.equal(r.ramUsed, 0x10);
  const over = [
    { vaddr: RAM_BASE + RAM_SIZE - 0x10, paddr: ALIAS_A, filesz: 0x10, memsz: 0x11 },
  ];
  assertRejected(buildElf({ segments: over }), target);
});

test("truncated program header table is rejected", () => {
  const segs = [
    { vaddr: ALIAS_A, paddr: ALIAS_A, filesz: 0x10, memsz: 0x10 },
    { vaddr: ALIAS_A + 0x100, paddr: ALIAS_A + 0x100, filesz: 0x10, memsz: 0x10 },
  ];
  assertRejected(buildElf({ segments: segs, phnumOverride: 0x100 }), makeTarget());
  // table claims 2 entries but file ends inside the second
  assertRejected(buildElf({ segments: segs, truncateTo: 52 + 32 + 16 }), makeTarget());
});

test("truncated payload is rejected", () => {
  const segs = [{ vaddr: ALIAS_A, paddr: ALIAS_A, filesz: 0x100, memsz: 0x100 }];
  const full = buildElf({ segments: segs });
  assertRejected(buildElf({ segments: segs, truncateTo: full.length - 1 }), makeTarget());
});

// ---------- header and structural validation ----------

test("ELF identification and fixed header fields are enforced", () => {
  const segs = [{ vaddr: ALIAS_A, paddr: ALIAS_A, filesz: 0x10, memsz: 0x10 }];
  const good = buildElf({ segments: segs });
  analyzeFirmware(good, makeTarget());

  const badMagic = new Uint8Array(good);
  badMagic[1] = 0x00;
  assertRejected(badMagic, makeTarget());

  assertRejected(buildElf({ segments: segs, eiClass: 2 }), makeTarget());
  assertRejected(buildElf({ segments: segs, eiData: 2 }), makeTarget());
  assertRejected(buildElf({ segments: segs, eiVersion: 0 }), makeTarget());
  assertRejected(buildElf({ segments: segs, type: 3 }), makeTarget());
  assertRejected(buildElf({ segments: segs, machine: 62 }), makeTarget());
  assertRejected(buildElf({ segments: segs, eVersion: 2 }), makeTarget());
  assertRejected(buildElf({ segments: segs, ehdrSize: 48 }), makeTarget());
  assertRejected(buildElf({ segments: segs, phentSize: 30 }), makeTarget());
  assertRejected(good.subarray(0, 40), makeTarget());
});

test("filesz greater than memsz is rejected", () => {
  const segs = [{ vaddr: ALIAS_A, paddr: ALIAS_A, filesz: 0x20, memsz: 0x10 }];
  assertRejected(buildElf({ segments: segs }), makeTarget());
});

test("non-PT_LOAD segments are ignored entirely", () => {
  const segs = [
    { type: 0x70000001, vaddr: 0x1, paddr: 0x2, filesz: 0x30, memsz: 0x30 },
    { vaddr: ALIAS_A, paddr: ALIAS_A, filesz: 0x10, memsz: 0x10 },
  ];
  const r = analyzeFirmware(buildElf({ segments: segs }), makeTarget());
  assert.equal(r.flashUsed, 0x10);
});

// ---------- flash runtime mapping rules ----------

test("flash runtime range must map to the same physical offset as the load", () => {
  // vaddr on alias B, paddr on alias A, same physical offset 0x100: legal
  const same = [{ vaddr: ALIAS_B + 0x100, paddr: ALIAS_A + 0x100, filesz: 0x40, memsz: 0x40 }];
  const r = analyzeFirmware(buildElf({ segments: same }), makeTarget());
  assert.equal(r.flashUsed, 0x40);

  const different = [
    { vaddr: ALIAS_B + 0x200, paddr: ALIAS_A + 0x100, filesz: 0x40, memsz: 0x40 },
  ];
  assertRejected(buildElf({ segments: different }), makeTarget());

  const bssInFlash = [{ vaddr: ALIAS_A + 0x100, paddr: ALIAS_A + 0x100, filesz: 0x40, memsz: 0x80 }];
  assertRejected(buildElf({ segments: bssInFlash }), makeTarget());
});

test("load address outside every flash window is rejected", () => {
  const segs = [{ vaddr: RAM_BASE, paddr: 0x40000000, filesz: 0x10, memsz: 0x10 }];
  assertRejected(buildElf({ segments: segs }), makeTarget());
});

// ---------- readFlash contract ----------

test("readFlash enforces range limits", () => {
  const segs = [{ vaddr: ALIAS_A, paddr: ALIAS_A, filesz: 0x10, memsz: 0x10 }];
  const r = analyzeFirmware(buildElf({ segments: segs }), makeTarget());
  assert.throws(() => readFlash(r, 0, 0x10001), FirmwareError);
  assert.equal(readFlash(r, 0, 0x10000).length, 0x10000);
  assert.throws(() => readFlash(r, FLASH_SIZE - 0x10, 0x11), FirmwareError);
  assert.throws(() => readFlash(r, -1, 0x10), FirmwareError);
  assert.equal(readFlash(r, FLASH_SIZE, 0).length, 0);
});

test("overlapping identical loads normalize to one physical range for reads", () => {
  const d = fillPattern(77, 0x80);
  const segs = [
    { vaddr: ALIAS_A + 0x40, paddr: ALIAS_A + 0x40, filesz: 0x80, memsz: 0x80, data: d },
    { vaddr: ALIAS_B + 0x40, paddr: ALIAS_B + 0x40, filesz: 0x80, memsz: 0x80, data: d },
  ];
  const r = analyzeFirmware(buildElf({ segments: segs }), makeTarget());
  assert.equal(r.flashUsed, 0x80);
  assert.deepEqual([...readFlash(r, 0x40, 0x80)], [...d]);
});
