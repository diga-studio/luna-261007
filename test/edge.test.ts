import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeFirmware, readFlash } from "../src/analyze.js";
import type { HardwareTarget } from "../src/types.js";
import { buildElf, pattern, type SegmentSpec } from "./elfBuilder.js";

const FLASH_SIZE = 0x10000;
const ALIAS0 = 0x08000000;
const RAM_BASE = 0x20000000;
const RAM_SIZE = 0x10000;

function makeTarget(overrides: Partial<HardwareTarget> = {}): HardwareTarget {
  return {
    flashSize: FLASH_SIZE,
    flashAliases: [ALIAS0],
    ramBase: RAM_BASE,
    ramSize: RAM_SIZE,
    flashBudget: FLASH_SIZE,
    ramBudget: RAM_SIZE,
    ...overrides,
  };
}

function flashSeg(paddrDelta: number, size: number, off = 0x100): SegmentSpec {
  return {
    offset: off,
    vaddr: ALIAS0 + paddrDelta,
    paddr: ALIAS0 + paddrDelta,
    filesz: size,
    memsz: size,
    data: pattern(11, size),
  };
}

test("载荷恰好贴到 flash 窗口末端：接受", () => {
  const elf = buildElf({ segments: [flashSeg(FLASH_SIZE - 0x20, 0x20)] });
  const result = analyzeFirmware(elf, makeTarget());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.flashUsed, 0x20);
});

test("载荷超出 flash 窗口末端一字节：拒绝", () => {
  const elf = buildElf({ segments: [flashSeg(FLASH_SIZE - 0x1f, 0x20)] });
  assert.ok(!analyzeFirmware(elf, makeTarget()).ok);
});

test("RAM 运行区恰好贴到窗口末端：接受", () => {
  const elf = buildElf({
    segments: [{
      offset: 0x100, vaddr: RAM_BASE + RAM_SIZE - 0x10, paddr: ALIAS0,
      filesz: 0x10, memsz: 0x10, data: pattern(1, 0x10),
    }],
  });
  assert.ok(analyzeFirmware(elf, makeTarget()).ok);
});

test("RAM 运行区跨出窗口末端：拒绝", () => {
  const elf = buildElf({
    segments: [{
      offset: 0x100, vaddr: RAM_BASE + RAM_SIZE - 0x08, paddr: ALIAS0,
      filesz: 0x10, memsz: 0x10, data: pattern(1, 0x10),
    }],
  });
  assert.ok(!analyzeFirmware(elf, makeTarget()).ok);
});

test("地址末端允许等于 2^32：贴边的段接受，回绕的段拒绝", () => {
  // 窗口 [0xFFFF0000, 2^32)，末端恰好是 2^32。
  const topTarget = makeTarget({
    flashAliases: [0xffff0000],
    ramBase: 0xefff0000,
    ramSize: 0x10000,
  });
  const fit = buildElf({
    segments: [{
      offset: 0x100, vaddr: 0xfffffff0, paddr: 0xfffffff0,
      filesz: 0x10, memsz: 0x10, data: pattern(1, 0x10),
    }],
  });
  assert.ok(analyzeFirmware(fit, topTarget).ok);

  // 末端 0x1_0000_0008 超出 2^32，若按 32 位回绕会变成小地址而误判合法。
  const wrap = buildElf({
    segments: [{
      offset: 0x100, vaddr: 0xfffffff8, paddr: 0xfffffff8,
      filesz: 0x10, memsz: 0x10, data: pattern(1, 0x10),
    }],
  });
  assert.ok(!analyzeFirmware(wrap, topTarget).ok);

  // RAM 运行区回绕同样拒绝。
  const ramWrap = buildElf({
    segments: [{
      offset: 0x100, vaddr: 0xeffffff8, paddr: 0xffff0000,
      filesz: 0x10, memsz: 0x10, data: pattern(1, 0x10),
    }],
  });
  assert.ok(!analyzeFirmware(ramWrap, topTarget).ok);
});

test("截断的段表：拒绝", () => {
  const elf = buildElf({
    segments: [flashSeg(0, 0x10)],
    phnum: 4, // 声称 4 项，文件只容纳 1 项
    fileSize: 52 + 32 * 2,
  });
  assert.ok(!analyzeFirmware(elf, makeTarget()).ok);
});

test("截断的载荷：拒绝", () => {
  const seg = flashSeg(0, 0x40, 0x100);
  const full = buildElf({ segments: [seg] });
  const truncated = full.subarray(0, 0x120); // 载荷只留一半
  assert.ok(!analyzeFirmware(truncated, makeTarget()).ok);
});

test("文件小于 ELF 头：拒绝", () => {
  assert.ok(!analyzeFirmware(new Uint8Array(51), makeTarget()).ok);
});

test("ELF 标识与规定的类型、版本逐项校验", () => {
  const base = { segments: [flashSeg(0, 0x10)] };
  const cases: Array<[string, Parameters<typeof buildElf>[0]]> = [
    ["badMagic", { ...base, badMagic: true }],
    ["eiClass", { ...base, eiClass: 2 }],
    ["eiData", { ...base, eiData: 2 }],
    ["eiVersion", { ...base, eiVersion: 0 }],
    ["eType", { ...base, eType: 3 }],
    ["eMachine", { ...base, eMachine: 62 }],
    ["eVersion", { ...base, eVersion: 2 }],
    ["ehsize", { ...base, ehsize: 51 }],
    ["phentsize", { ...base, phentsize: 31 }],
  ];
  for (const [name, opts] of cases) {
    const result = analyzeFirmware(buildElf(opts), makeTarget());
    assert.ok(!result.ok, `expected rejection: ${name}`);
  }
});

test("p_filesz 大于 p_memsz：拒绝", () => {
  const elf = buildElf({
    segments: [{ offset: 0x100, vaddr: RAM_BASE, paddr: ALIAS0, filesz: 0x20, memsz: 0x10, data: pattern(1, 0x20) }],
  });
  assert.ok(!analyzeFirmware(elf, makeTarget()).ok);
});

test("非 PT_LOAD 段的载荷不被读取", () => {
  const elf = buildElf({
    segments: [
      // 指向文件外、地址非法，但类型不是 PT_LOAD，必须被忽略。
      { type: 4, offset: 0x70000000, vaddr: 0x12345678, paddr: 0x12345678, filesz: 0x1000, memsz: 0x70000000 },
      flashSeg(0, 0x10),
    ],
    fileSize: 0x200,
  });
  const result = analyzeFirmware(elf, makeTarget());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.flashUsed, 0x10);
});

test("flash 运行区规则：memsz 不等于 filesz 或物理偏移不一致时拒绝", () => {
  // vaddr 在 flash 但 memsz > filesz（flash 中不允许 BSS）。
  const bss = buildElf({
    segments: [{ offset: 0x100, vaddr: ALIAS0 + 0x40, paddr: ALIAS0 + 0x40, filesz: 0x10, memsz: 0x20, data: pattern(1, 0x10) }],
  });
  assert.ok(!analyzeFirmware(bss, makeTarget()).ok);

  // vaddr 与 paddr 映射到不同物理偏移。
  const moved = buildElf({
    segments: [{ offset: 0x100, vaddr: ALIAS0 + 0x80, paddr: ALIAS0 + 0x40, filesz: 0x10, memsz: 0x10, data: pattern(1, 0x10) }],
  });
  assert.ok(!analyzeFirmware(moved, makeTarget()).ok);
});

test("运行区落在所有窗口之外：拒绝", () => {
  const elf = buildElf({
    segments: [{ offset: 0x100, vaddr: 0x40000000, paddr: ALIAS0, filesz: 0x10, memsz: 0x10, data: pattern(1, 0x10) }],
  });
  assert.ok(!analyzeFirmware(elf, makeTarget()).ok);
});

test("readFlash 参数校验", () => {
  const elf = buildElf({ segments: [flashSeg(0, 0x10)] });
  const result = analyzeFirmware(elf, makeTarget());
  assert.ok(result.ok);
  assert.throws(() => readFlash(result.image, 0, 0x10001), RangeError); // 超 64 KiB
  assert.throws(() => readFlash(result.image, FLASH_SIZE - 0x10, 0x20), RangeError); // 越界
  assert.throws(() => readFlash(result.image, -1, 0x10), RangeError);
  assert.throws(() => readFlash(result.image, 0.5, 0x10), RangeError);
  assert.equal(readFlash(result.image, 0, 0x10000).length, 0x10000); // 恰好 64 KiB 允许
  assert.equal(readFlash(result.image, FLASH_SIZE, 0).length, 0); // 末端空读允许
});

test("配置自身非法时拒绝", () => {
  const elf = buildElf({ segments: [flashSeg(0, 0x10)] });
  // 窗口互相重叠
  assert.ok(!analyzeFirmware(elf, makeTarget({ flashAliases: [ALIAS0, ALIAS0 + 0x10] })).ok);
  assert.ok(!analyzeFirmware(elf, makeTarget({ ramBase: ALIAS0 })).ok);
  // 预算超过容量
  assert.ok(!analyzeFirmware(elf, makeTarget({ flashBudget: FLASH_SIZE + 1 })).ok);
  assert.ok(!analyzeFirmware(elf, makeTarget({ ramBudget: RAM_SIZE + 1 })).ok);
});
