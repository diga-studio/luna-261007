import { Hundredths, parseHundredths, formatHalfUp } from './decimal';

/** One row of the leaderboard / the result of a rank query. */
export interface RankEntry {
  studentId: string;
  /** Display GPA: exact value rounded to two decimals, half-up. */
  gpa: string;
  /** Competition rank: 1 + number of students with a strictly higher exact GPA. */
  rank: number;
}

interface StudentRecord {
  /** courseId -> points (hundredths). */
  points: Map<string, Hundredths>;
  /** courseId -> credits (hundredths). */
  credits: Map<string, Hundredths>;
  /** Sum of points*credits over all courses (exact, in 1/10000 units). */
  weightedSum: bigint;
  /** Sum of credits over all courses (hundredths). */
  creditSum: bigint;
}

interface ScoredStudent {
  studentId: string;
  weightedSum: bigint;
  creditSum: bigint;
}

/** Compare exact GPAs a/b without rounding: returns negative if a's GPA is higher. */
function compareGpaDesc(a: ScoredStudent, b: ScoredStudent): number {
  const left = a.weightedSum * b.creditSum;
  const right = b.weightedSum * a.creditSum;
  if (left !== right) {
    return left > right ? -1 : 1;
  }
  // Exact tie: studentId in ascending ASCII (code-unit) order.
  if (a.studentId !== b.studentId) {
    return a.studentId < b.studentId ? -1 : 1;
  }
  return 0;
}

function requireNonEmptyId(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

/**
 * Single-semester real-time GPA leaderboard.
 * Calls execute serially; all state lives in memory.
 */
export class GpaLeaderboard {
  private readonly students = new Map<string, StudentRecord>();

  /** Add a grade, or replace points/credits if the student already has this course. */
  upsertGrade(studentId: string, courseId: string, points: string, credits: string): void {
    requireNonEmptyId(studentId, 'studentId');
    requireNonEmptyId(courseId, 'courseId');
    const pointsValue = parseHundredths(points, 'points');
    const creditsValue = parseHundredths(credits, 'credits');
    if (creditsValue <= 0n) {
      throw new Error('credits must be greater than 0.00');
    }

    let record = this.students.get(studentId);
    if (record === undefined) {
      record = { points: new Map(), credits: new Map(), weightedSum: 0n, creditSum: 0n };
      this.students.set(studentId, record);
    }

    const oldPoints = record.points.get(courseId);
    const oldCredits = record.credits.get(courseId);
    if (oldPoints !== undefined && oldCredits !== undefined) {
      record.weightedSum -= oldPoints * oldCredits;
      record.creditSum -= oldCredits;
    }

    record.points.set(courseId, pointsValue);
    record.credits.set(courseId, creditsValue);
    record.weightedSum += pointsValue * creditsValue;
    record.creditSum += creditsValue;
  }

  /** Remove the grade for this course. No-op if it does not exist. */
  removeGrade(studentId: string, courseId: string): void {
    requireNonEmptyId(studentId, 'studentId');
    requireNonEmptyId(courseId, 'courseId');
    const record = this.students.get(studentId);
    if (record === undefined) {
      return;
    }
    const oldPoints = record.points.get(courseId);
    const oldCredits = record.credits.get(courseId);
    if (oldPoints === undefined || oldCredits === undefined) {
      return;
    }
    record.weightedSum -= oldPoints * oldCredits;
    record.creditSum -= oldCredits;
    record.points.delete(courseId);
    record.credits.delete(courseId);
    if (record.points.size === 0) {
      this.students.delete(studentId);
    }
  }

  /** Display GPA and competition rank, or null if the student has no grades. */
  studentRank(studentId: string): RankEntry | null {
    requireNonEmptyId(studentId, 'studentId');
    if (!this.students.has(studentId)) {
      return null;
    }
    for (const entry of this.rankedEntries()) {
      if (entry.studentId === studentId) {
        return entry;
      }
    }
    return null;
  }

  /** Zero-offset page of the full leaderboard (GPA desc, studentId asc on exact ties). */
  leaderboard(offset: number, limit: number): RankEntry[] {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error('offset must be a non-negative integer');
    }
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error('limit must be a non-negative integer');
    }
    return this.rankedEntries().slice(offset, offset + limit);
  }

  /** Full sorted leaderboard with competition ranks, computed from current state. */
  private rankedEntries(): RankEntry[] {
    const scored: ScoredStudent[] = [];
    for (const [studentId, record] of this.students) {
      scored.push({ studentId, weightedSum: record.weightedSum, creditSum: record.creditSum });
    }
    scored.sort(compareGpaDesc);

    const entries: RankEntry[] = [];
    for (let index = 0; index < scored.length; index += 1) {
      const current = scored[index]!;
      let rank = index + 1;
      if (index > 0) {
        const previous = scored[index - 1]!;
        const sameGpa = current.weightedSum * previous.creditSum === previous.weightedSum * current.creditSum;
        if (sameGpa) {
          rank = entries[index - 1]!.rank;
        }
      }
      entries.push({
        studentId: current.studentId,
        // weightedSum/creditSum is the GPA in hundredths; divide by 100 more for the true GPA.
        gpa: formatHalfUp(current.weightedSum, current.creditSum * 100n),
        rank,
      });
    }
    return entries;
  }
}
