import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeFirmware, readFlash } from "../src/analyze.js";
import type { HardwareTarget } from "../src/types.js";
import { buildElf, pattern } from "./elfBuilder.js";

const FLASH_SIZE = 0x10000;
const ALIAS0 = 0x08000000;
const RAM_BASE = 0x20000000;
const RAM_SIZE = 0x10000000; // 256 MiB，验证内存不随声明容量膨胀

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

// 段 A：RAM 初始化段，载荷 0x20 字节，落在巨大 BSS 段 B 的零填充区内。
// 段 B：纯 BSS，vaddr = RAM_BASE，memsz = 256 MiB，filesz = 0。
function ramBssElf(payloadByte: number): Uint8Array {
  const dataA = new Uint8Array(0x20).fill(payloadByte);
  return buildElf({
    segments: [
      {
        offset: 0x400,
        vaddr: RAM_BASE + 0x8000,
        paddr: ALIAS0 + 0x400,
        filesz: 0x20,
        memsz: 0x20,
        data: dataA,
      },
      {
        offset: 0,
        vaddr: RAM_BASE,
        paddr: 0, // filesz 为 0，p_paddr 被忽略
        filesz: 0,
        memsz: RAM_SIZE,
      },
    ],
  });
}

test("RAM 初始化段与巨大 BSS 零尾重叠：重叠字节为零时接受", () => {
  const result = analyzeFirmware(ramBssElf(0x00), makeTarget());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.ramUsed, RAM_SIZE); // 并集即整个 BSS
  assert.equal(result.flashUsed, 0x20); // 只有 A 的载荷占用 flash
});

test("RAM 初始化段与 BSS 零尾重叠：重叠字节非零时拒绝", () => {
  const result = analyzeFirmware(ramBssElf(0x5a), makeTarget());
  assert.ok(!result.ok);
});

test("RAM 预算超限拒绝，且与 flash 预算独立核算", () => {
  const ok = analyzeFirmware(ramBssElf(0x00), makeTarget());
  assert.ok(ok.ok);
  const ramDenied = analyzeFirmware(
    ramBssElf(0x00),
    makeTarget({ ramBudget: RAM_SIZE - 1 }),
  );
  assert.ok(!ramDenied.ok);
  const flashDenied = analyzeFirmware(
    ramBssElf(0x00),
    makeTarget({ flashBudget: 0x1f }),
  );
  assert.ok(!flashDenied.ok);
});

test("flash 空洞不计占用，局部读取未覆盖处为 0xFF", () => {
  const elf = ramBssElf(0x00);
  const result = analyzeFirmware(elf, makeTarget());
  assert.ok(result.ok);
  // 载荷在物理 [0x400, 0x420)，前后都是空洞。
  const buf = readFlash(result.image, 0x3f0, 0x60);
  assert.equal(buf.length, 0x60);
  assert.ok(buf.subarray(0, 0x10).every((b) => b === 0xff)); // 前导空洞
  assert.ok(buf.subarray(0x10, 0x30).every((b) => b === 0x00)); // 载荷
  assert.ok(buf.subarray(0x30).every((b) => b === 0xff)); // 尾部空洞
});

test("flash 两端散布的小载荷：跨度大但占用小，预算按并集计", () => {
  const elf = buildElf({
    segments: [
      { offset: 0x100, vaddr: ALIAS0, paddr: ALIAS0, filesz: 0x10, memsz: 0x10, data: pattern(1, 0x10) },
      { offset: 0x200, vaddr: ALIAS0 + FLASH_SIZE - 0x10, paddr: ALIAS0 + FLASH_SIZE - 0x10, filesz: 0x10, memsz: 0x10, data: pattern(2, 0x10) },
    ],
  });
  // 若按“最高地址减基址”核算会得到 64 KiB，这里预算只给 0x20。
  const result = analyzeFirmware(elf, makeTarget({ flashBudget: 0x20 }));
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.flashUsed, 0x20);
});

test("两个 RAM 段的载荷重叠且字节相同：接受", () => {
  const data = pattern(5, 0x30);
  const elf = buildElf({
    segments: [
      { offset: 0x100, vaddr: RAM_BASE + 0x40, paddr: ALIAS0 + 0x100, filesz: 0x30, memsz: 0x30, data },
      { offset: 0x200, vaddr: RAM_BASE + 0x50, paddr: ALIAS0 + 0x200, filesz: 0x20, memsz: 0x20, data: data.subarray(0x10) },
    ],
  });
  const result = analyzeFirmware(elf, makeTarget());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.ramUsed, 0x30);
});

test("两个 RAM 段的载荷重叠但字节不同：拒绝", () => {
  const elf = buildElf({
    segments: [
      { offset: 0x100, vaddr: RAM_BASE + 0x40, paddr: ALIAS0 + 0x100, filesz: 0x30, memsz: 0x30, data: pattern(5, 0x30) },
      { offset: 0x200, vaddr: RAM_BASE + 0x50, paddr: ALIAS0 + 0x200, filesz: 0x20, memsz: 0x20, data: pattern(6, 0x20) },
    ],
  });
  assert.ok(!analyzeFirmware(elf, makeTarget()).ok);
});

test("一个段的零填充尾与另一个段的零载荷重叠：接受", () => {
  const elf = buildElf({
    segments: [
      // filesz 0x10 + bss 尾 0x20：RAM [0x40, 0x70)
      { offset: 0x100, vaddr: RAM_BASE + 0x40, paddr: ALIAS0 + 0x100, filesz: 0x10, memsz: 0x30, data: pattern(8, 0x10) },
      // 纯 BSS：RAM [0x50, 0x90)，与前者的零尾 [0x50, 0x70) 重叠
      { offset: 0, vaddr: RAM_BASE + 0x50, paddr: 0, filesz: 0, memsz: 0x40 },
    ],
  });
  const result = analyzeFirmware(elf, makeTarget());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.ramUsed, 0x50); // [0x40, 0x90)
});
