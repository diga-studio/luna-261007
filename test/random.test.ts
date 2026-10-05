import { test } from "node:test";
import { deepEqual } from "node:assert/strict";
import { GpaLeaderboard } from "../src/index";

/** Seeded PRNG (mulberry32) so failures are reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RefEntry {
  studentId: string;
  gpa: string;
  rank: number;
}

/**
 * Independent reference model: stores raw grades and recomputes everything
 * from scratch with its own exact rational arithmetic.
 */
class ReferenceModel {
  private readonly grades = new Map<string, Map<string, { p: bigint; c: bigint }>>();

  upsert(studentId: string, courseId: string, p: bigint, c: bigint): void {
    let courses = this.grades.get(studentId);
    if (courses === undefined) {
      courses = new Map();
      this.grades.set(studentId, courses);
    }
    courses.set(courseId, { p, c });
  }

  remove(studentId: string, courseId: string): void {
    const courses = this.grades.get(studentId);
    if (courses === undefined || !courses.delete(courseId)) return;
    if (courses.size === 0) this.grades.delete(studentId);
  }

  private aggregates(): Array<{ studentId: string; sum: bigint; credits: bigint }> {
    const result = [];
    for (const [studentId, courses] of this.grades) {
      let sum = 0n;
      let credits = 0n;
      for (const { p, c } of courses.values()) {
        sum += p * c;
        credits += c;
      }
      result.push({ studentId, sum, credits });
    }
    return result;
  }

  private static cmp(a: { sum: bigint; credits: bigint }, b: { sum: bigint; credits: bigint }): number {
    const left = a.sum * b.credits;
    const right = b.sum * a.credits;
    return left < right ? -1 : left > right ? 1 : 0;
  }

  /** Half-up rounding to two decimals, computed via scaled-by-1000 division. */
  private static display(sum: bigint, credits: bigint): string {
    const denominator = credits * 100n;
    const scaled = (sum * 1000n + denominator * 5n) / (denominator * 10n);
    return `${scaled / 100n}.${(scaled % 100n).toString().padStart(2, "0")}`;
  }

  board(): RefEntry[] {
    const aggregates = this.aggregates();
    const sorted = [...aggregates].sort((a, b) => {
      const byGpa = ReferenceModel.cmp(b, a);
      if (byGpa !== 0) return byGpa;
      return a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0;
    });
    return sorted.map((entry) => {
      let higher = 0;
      for (const other of aggregates) {
        if (ReferenceModel.cmp(other, entry) > 0) higher += 1;
      }
      return {
        studentId: entry.studentId,
        gpa: ReferenceModel.display(entry.sum, entry.credits),
        rank: higher + 1,
      };
    });
  }

  rankOf(studentId: string): RefEntry | null {
    return this.board().find((entry) => entry.studentId === studentId) ?? null;
  }
}

function toScaled(cents: number): { value: bigint; text: string } {
  return { value: BigInt(cents), text: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}` };
}

function runSequence(seed: number, steps: number): void {
  const random = makeRandom(seed);
  const board = new GpaLeaderboard();
  const reference = new ReferenceModel();
  const studentIds = ["s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08"];
  const courseIds = ["c1", "c2", "c3", "c4", "c5", "c6"];

  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

  const checkAll = (step: number): void => {
    const expected = reference.board();
    deepEqual(board.leaderboard(0, 1000), expected, `step ${step}: full board`);
    // Every student's individual rank lookup.
    for (const studentId of studentIds) {
      deepEqual(board.studentRank(studentId), reference.rankOf(studentId), `step ${step}: rank of ${studentId}`);
    }
    // Pages of sizes 1..4 at every offset must slice the full board.
    for (let limit = 1; limit <= 4; limit += 1) {
      for (let offset = 0; offset <= expected.length; offset += 1) {
        deepEqual(
          board.leaderboard(offset, limit),
          expected.slice(offset, offset + limit),
          `step ${step}: page (${offset}, ${limit})`,
        );
      }
    }
  };

  for (let step = 0; step < steps; step += 1) {
    const studentId = pick(studentIds);
    const courseId = pick(courseIds);
    if (random() < 0.3) {
      board.removeGrade(studentId, courseId);
      reference.remove(studentId, courseId);
    } else {
      // Points 0.00..4.30 in 0.01 steps, credits 0.50..5.00 in 0.01 steps.
      const points = toScaled(Math.floor(random() * 431));
      const credits = toScaled(50 + Math.floor(random() * 451));
      board.upsertGrade(studentId, courseId, points.text, credits.text);
      reference.upsert(studentId, courseId, points.value, credits.value);
    }
    checkAll(step);
  }
}

test("random update sequences match the reference model", () => {
  for (const seed of [1, 42, 2026]) {
    runSequence(seed, 150);
  }
});
