import { parseScaled, formatGpa } from "./decimal";

export interface StudentRankResult {
  studentId: string;
  gpa: string;
  rank: number;
}

export interface LeaderboardEntry {
  studentId: string;
  gpa: string;
  rank: number;
}

interface Grade {
  /** points * 100 */
  pointsScaled: bigint;
  /** credits * 100 */
  creditsScaled: bigint;
}

interface Aggregate {
  /** sum of pointsScaled * creditsScaled over all courses (scale 10000) */
  sum: bigint;
  /** sum of creditsScaled over all courses (scale 100) */
  credits: bigint;
}

/** Compare two aggregates by exact GPA: a.sum/a.credits vs b.sum/b.credits. */
function compareGpa(a: Aggregate, b: Aggregate): number {
  const left = a.sum * b.credits;
  const right = b.sum * a.credits;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export class GpaLeaderboard {
  private readonly grades = new Map<string, Map<string, Grade>>();
  private readonly aggregates = new Map<string, Aggregate>();

  upsertGrade(studentId: string, courseId: string, points: string, credits: string): void {
    requireNonEmpty(studentId, "studentId");
    requireNonEmpty(courseId, "courseId");
    const pointsScaled = parseScaled(points);
    const creditsScaled = parseScaled(credits);
    if (creditsScaled <= 0n) {
      throw new Error("credits must be positive");
    }

    let courses = this.grades.get(studentId);
    if (courses === undefined) {
      courses = new Map();
      this.grades.set(studentId, courses);
    }
    const previous = courses.get(courseId);
    courses.set(courseId, { pointsScaled, creditsScaled });

    const aggregate = this.aggregates.get(studentId) ?? { sum: 0n, credits: 0n };
    if (previous !== undefined) {
      aggregate.sum -= previous.pointsScaled * previous.creditsScaled;
      aggregate.credits -= previous.creditsScaled;
    }
    aggregate.sum += pointsScaled * creditsScaled;
    aggregate.credits += creditsScaled;
    this.aggregates.set(studentId, aggregate);
  }

  removeGrade(studentId: string, courseId: string): void {
    const courses = this.grades.get(studentId);
    const previous = courses?.get(courseId);
    if (courses === undefined || previous === undefined) {
      return;
    }
    courses.delete(courseId);
    const aggregate = this.aggregates.get(studentId)!;
    aggregate.sum -= previous.pointsScaled * previous.creditsScaled;
    aggregate.credits -= previous.creditsScaled;
    if (courses.size === 0) {
      this.grades.delete(studentId);
      this.aggregates.delete(studentId);
    }
  }

  studentRank(studentId: string): StudentRankResult | null {
    const aggregate = this.aggregates.get(studentId);
    if (aggregate === undefined) {
      return null;
    }
    let rank = 1;
    for (const [otherId, other] of this.aggregates) {
      if (otherId !== studentId && compareGpa(other, aggregate) > 0) {
        rank += 1;
      }
    }
    return { studentId, gpa: formatGpa(aggregate.sum, aggregate.credits * 100n), rank };
  }

  leaderboard(offset: number, limit: number): LeaderboardEntry[] {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("offset must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("limit must be a non-negative integer");
    }

    const sorted = [...this.aggregates.entries()].sort((a, b) => {
      const byGpa = compareGpa(b[1], a[1]);
      if (byGpa !== 0) return byGpa;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

    const ranks = new Array<number>(sorted.length);
    let higherCount = 0;
    for (let i = 0; i < sorted.length; i += 1) {
      if (i > 0 && compareGpa(sorted[i - 1][1], sorted[i][1]) !== 0) {
        higherCount = i;
      }
      ranks[i] = higherCount + 1;
    }

    return sorted.slice(offset, offset + limit).map(([studentId, aggregate], index) => ({
      studentId,
      gpa: formatGpa(aggregate.sum, aggregate.credits * 100n),
      rank: ranks[offset + index],
    }));
  }
}

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}
