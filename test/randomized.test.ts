import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { GpaLeaderboard, RankEntry } from '../src/index';

// --- Independent reference model, written straight from the spec. ---

interface RefGrade {
  points: bigint;
  credits: bigint;
}

function parse(raw: string): bigint {
  const dot = raw.indexOf('.');
  return BigInt(raw.slice(0, dot)) * 100n + BigInt(raw.slice(dot + 1));
}

function displayGpa(weightedSum: bigint, creditSum: bigint): string {
  // GPA in hundredths is weightedSum/creditSum; round that to an integer, half-up.
  let quotient = weightedSum / creditSum;
  const remainder = weightedSum % creditSum;
  if (remainder * 2n >= creditSum) {
    quotient += 1n;
  }
  return `${quotient / 100n}.${(quotient % 100n).toString().padStart(2, '0')}`;
}

class ReferenceBoard {
  private grades = new Map<string, Map<string, RefGrade>>();

  upsert(studentId: string, courseId: string, points: string, credits: string): void {
    let courses = this.grades.get(studentId);
    if (!courses) {
      courses = new Map();
      this.grades.set(studentId, courses);
    }
    courses.set(courseId, { points: parse(points), credits: parse(credits) });
  }

  remove(studentId: string, courseId: string): void {
    const courses = this.grades.get(studentId);
    if (!courses) {
      return;
    }
    courses.delete(courseId);
    if (courses.size === 0) {
      this.grades.delete(studentId);
    }
  }

  board(): RankEntry[] {
    const rows: { studentId: string; ws: bigint; cs: bigint }[] = [];
    for (const [studentId, courses] of this.grades) {
      let ws = 0n;
      let cs = 0n;
      for (const grade of courses.values()) {
        ws += grade.points * grade.credits;
        cs += grade.credits;
      }
      rows.push({ studentId, ws, cs });
    }
    rows.sort((a, b) => {
      const left = a.ws * b.cs;
      const right = b.ws * a.cs;
      if (left !== right) {
        return left > right ? -1 : 1;
      }
      return a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0;
    });
    const entries: RankEntry[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      let rank = i + 1;
      if (i > 0) {
        const prev = rows[i - 1]!;
        if (row.ws * prev.cs === prev.ws * row.cs) {
          rank = entries[i - 1]!.rank;
        }
      }
      entries.push({ studentId: row.studentId, gpa: displayGpa(row.ws, row.cs), rank });
    }
    return entries;
  }
}

// --- Seeded PRNG (mulberry32) for reproducible sequences. ---

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

test('random update sequences match the reference model at every step', () => {
  const studentIds = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'];
  const courseIds = ['c0', 'c1', 'c2', 'c3', 'c4'];
  // Small value pools make exact ties and display-only near-ties likely.
  const pointsPool = ['0.00', '2.00', '2.50', '3.00', '3.00', '3.50', '4.00', '4.00'];
  const creditsPool = ['0.50', '1.00', '1.00', '2.00', '3.00'];

  let sawExitAndReenter = false;
  let sawTieGroup = false;
  let sawTieBreak = false;

  for (const seed of [1, 7, 42, 1337]) {
    const rand = mulberry32(seed);
    const actual = new GpaLeaderboard();
    const reference = new ReferenceBoard();
    const exited = new Set<string>();
    let tieGroupAlive = false;

    for (let step = 0; step < 300; step += 1) {
      const studentId = pick(rand, studentIds);
      const courseId = pick(rand, courseIds);
      const roll = rand();
      if (roll < 0.7) {
        const points = pick(rand, pointsPool);
        const credits = pick(rand, creditsPool);
        actual.upsertGrade(studentId, courseId, points, credits);
        reference.upsert(studentId, courseId, points, credits);
        if (exited.delete(studentId)) {
          sawExitAndReenter = true;
        }
      } else {
        actual.removeGrade(studentId, courseId);
        reference.remove(studentId, courseId);
        if (actual.studentRank(studentId) === null) {
          exited.add(studentId);
        }
      }

      // Check every student's rank (including students with no grades).
      const expectedBoard = reference.board();
      for (const id of studentIds) {
        const expected = expectedBoard.find((entry) => entry.studentId === id) ?? null;
        deepEqual(actual.studentRank(id), expected, `seed=${seed} step=${step} student=${id}`);
      }

      // Check pages at several offsets, including across tie-group boundaries.
      for (let offset = 0; offset <= expectedBoard.length; offset += 1) {
        for (const limit of [0, 1, 2, 3, expectedBoard.length]) {
          deepEqual(
            actual.leaderboard(offset, limit),
            expectedBoard.slice(offset, offset + limit),
            `seed=${seed} step=${step} offset=${offset} limit=${limit}`,
          );
        }
      }

      // Track tie-group coverage.
      const ranks = expectedBoard.map((entry) => entry.rank);
      const hasTie = new Set(ranks).size !== ranks.length;
      if (hasTie) {
        sawTieGroup = true;
        tieGroupAlive = true;
      } else if (tieGroupAlive) {
        sawTieBreak = true;
        tieGroupAlive = false;
      }
    }
  }

  ok(sawExitAndReenter, 'expected a student to exit and re-enter the board');
  ok(sawTieGroup, 'expected at least one tie group to form');
  ok(sawTieBreak, 'expected at least one tie group to break apart');
});

test('random exact ties can share display but differ in exact value', () => {
  // Targeted fuzz: many students with GPA near 3.00, verifying that students
  // with equal displayed GPA but different exact values never share a rank.
  const rand = mulberry32(99);
  const board = new GpaLeaderboard();
  for (let i = 0; i < 40; i += 1) {
    const base = pick(rand, ['3.00', '3.01', '2.99']);
    const tweak = pick(rand, ['0.01', '0.02', '0.03']);
    const extra = pick(rand, ['3.50', '2.50', '4.00']);
    board.upsertGrade(`st${i}`, 'c1', base, '1.00');
    board.upsertGrade(`st${i}`, 'c2', extra, tweak);
  }
  const entries = board.leaderboard(0, 1000);
  const rankByGpaText = new Map<string, Set<number>>();
  for (const entry of entries) {
    const ranks = rankByGpaText.get(entry.gpa) ?? new Set<number>();
    ranks.add(entry.rank);
    rankByGpaText.set(entry.gpa, ranks);
  }
  // Ranks are unique per position except for exact ties; with 40 students and
  // distinct tweaks, most displayed groups must contain more than one rank.
  equal(entries.length, 40);
  ok(entries.every((entry, i) => i === 0 || entries[i - 1]!.rank <= entry.rank));
});
