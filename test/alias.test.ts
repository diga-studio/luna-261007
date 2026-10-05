import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeFirmware, readFlash } from "../src/analyze.js";
import type { HardwareTarget } from "../src/types.js";
import { buildElf, pattern, type SegmentSpec } from "./elfBuilder.js";

const FLASH_SIZE = 0x10000;
const ALIAS0 = 0x08000000;
const ALIAS1 = 0x10000000;
const RAM_BASE = 0x20000000;
const RAM_SIZE = 0x10000;

function makeTarget(overrides: Partial<HardwareTarget> = {}): HardwareTarget {
  return {
    flashSize: FLASH_SIZE,
    flashAliases: [ALIAS0, ALIAS1],
    ramBase: RAM_BASE,
    ramSize: RAM_SIZE,
    flashBudget: FLASH_SIZE,
    ramBudget: RAM_SIZE,
    ...overrides,
  };
}

const PAYLOAD_A_OFF = 0x100;
const PAYLOAD_B_OFF = 0x200;

// A 覆盖物理 [0x100, 0x140)，B 覆盖物理 [0x120, 0x160)，重叠 [0x120, 0x140)。
function overlappingSegments(mutateB: boolean): SegmentSpec[] {
  const dataA = pattern(7, 0x40);
  const dataB = new Uint8Array(0x40);
  dataB.set(dataA.subarray(0x20, 0x40), 0); // 与 A 的重叠部分逐字节相同
  dataB.set(pattern(9, 0x20), 0x20);
  if (mutateB) dataB[0x0f]! ^= 0x01; // 改动重叠区内一个字节
  return [
    {
      offset: PAYLOAD_A_OFF,
      vaddr: ALIAS0 + 0x100,
      paddr: ALIAS0 + 0x100,
      filesz: 0x40,
      memsz: 0x40,
      data: dataA,
    },
    {
      offset: PAYLOAD_B_OFF,
      vaddr: ALIAS1 + 0x120,
      paddr: ALIAS1 + 0x120,
      filesz: 0x40,
      memsz: 0x40,
      data: dataB,
    },
  ];
}

test("别名间部分重叠且字节相同：接受，占用只计一次", () => {
  const elf = buildElf({ segments: overlappingSegments(false) });
  const result = analyzeFirmware(elf, makeTarget());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.flashUsed, 0x60); // 物理 [0x100, 0x160) 的并集
  assert.equal(result.ramUsed, 0);

  const expect = new Uint8Array(0x60);
  const dataA = pattern(7, 0x40);
  expect.set(dataA, 0);
  expect.set(pattern(9, 0x20), 0x40);
  assert.deepEqual(readFlash(result.image, 0x100, 0x60), expect);
});

test("别名间重叠字节不同：拒绝", () => {
  const elf = buildElf({ segments: overlappingSegments(true) });
  const result = analyzeFirmware(elf, makeTarget());
  assert.ok(!result.ok);
});

test("交换段表顺序：结论、占用与读取内容不变", () => {
  const segments = overlappingSegments(false);
  const elfAB = buildElf({ segments });
  const elfBA = buildElf({ segments: [segments[1]!, segments[0]!] });

  const resAB = analyzeFirmware(elfAB, makeTarget());
  const resBA = analyzeFirmware(elfBA, makeTarget());
  assert.ok(resAB.ok && resBA.ok);
  assert.equal(resAB.flashUsed, resBA.flashUsed);
  assert.equal(resAB.ramUsed, resBA.ramUsed);
  assert.deepEqual(
    readFlash(resBA.image, 0x100, 0x60),
    readFlash(resAB.image, 0x100, 0x60),
  );
});

test("交换段表顺序后冲突判定同样不变", () => {
  const segments = overlappingSegments(true);
  const elfBA = buildElf({ segments: [segments[1]!, segments[0]!] });
  const result = analyzeFirmware(elfBA, makeTarget());
  assert.ok(!result.ok);
});

test("同一别名内的相同重叠同样合法", () => {
  const data = pattern(3, 0x30);
  const dataB = new Uint8Array(0x20);
  dataB.set(data.subarray(0x20, 0x30), 0); // 重叠区 [0x60, 0x70) 与 A 一致
  dataB.set(pattern(4, 0x10), 0x10);
  const elf = buildElf({
    segments: [
      { offset: 0x100, vaddr: ALIAS0 + 0x40, paddr: ALIAS0 + 0x40, filesz: 0x30, memsz: 0x30, data },
      { offset: 0x200, vaddr: ALIAS0 + 0x60, paddr: ALIAS0 + 0x60, filesz: 0x20, memsz: 0x20, data: dataB },
    ],
  });
  const result = analyzeFirmware(elf, makeTarget());
  assert.ok(result.ok, result.ok ? "" : result.error);
  assert.equal(result.flashUsed, 0x40); // 物理 [0x40, 0x80) 的并集
});
