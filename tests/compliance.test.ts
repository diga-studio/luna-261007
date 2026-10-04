import { describe, expect, it } from "vitest";
import {
  classCapacity,
  isClassCompliant,
  isTransferAreaCompliant,
} from "../src/index.js";

describe("classCapacity", () => {
  it("applies the strictest ratio among children present", () => {
    expect(classCapacity(1, ["infant"])).toBe(4);
    expect(classCapacity(1, ["toddler"])).toBe(6);
    expect(classCapacity(1, ["preschool"])).toBe(10);
    expect(classCapacity(1, ["preschool", "infant"])).toBe(4);
    expect(classCapacity(2, ["infant", "toddler"])).toBe(8);
  });

  it("caps capacity at 20 regardless of teacher count", () => {
    expect(classCapacity(3, ["preschool"])).toBe(20);
    expect(classCapacity(10, ["infant"])).toBe(20);
  });

  it("has no ratio restriction for an empty class", () => {
    expect(classCapacity(0, [])).toBe(Number.POSITIVE_INFINITY);
    expect(isClassCompliant({ id: "X", teachers: 0 }, [])).toBe(true);
  });
});

describe("isClassCompliant", () => {
  it("checks headcount against the derived capacity", () => {
    const classDef = { id: "A", teachers: 1 };
    expect(isClassCompliant(classDef, Array(4).fill("infant"))).toBe(true);
    expect(isClassCompliant(classDef, Array(5).fill("infant"))).toBe(false);
    // 3 preschoolers + 1 infant in a 1-teacher class: strictest ratio 4 -> ok.
    expect(
      isClassCompliant(classDef, ["preschool", "preschool", "preschool", "infant"]),
    ).toBe(true);
    // One more preschooler breaks it.
    expect(
      isClassCompliant(classDef, [
        "preschool",
        "preschool",
        "preschool",
        "preschool",
        "infant",
      ]),
    ).toBe(false);
  });
});

describe("isTransferAreaCompliant", () => {
  it("allows at most 2 children", () => {
    expect(isTransferAreaCompliant(0)).toBe(true);
    expect(isTransferAreaCompliant(2)).toBe(true);
    expect(isTransferAreaCompliant(3)).toBe(false);
  });
});
