import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXED_EXAM } from '../src/exam.js';
import type { Answer, Certificate } from '../src/types.js';

export const T0 = 1_700_000_000_000;
export const HOUR = 60 * 60 * 1000;

export function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'exam-test-'));
}

export function cleanDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** 第 index 题的错误答案（选中一个不在正确集合中的选项）。 */
function wrongAnswer(index: number): Answer {
  const question = FIXED_EXAM[index]!;
  const wrong = question.options.find((o) => !question.correct.includes(o.id));
  if (wrong) return { questionId: question.id, selected: [wrong.id] };
  // 正确集合覆盖全部选项时，少选一个即为错误答案。
  return { questionId: question.id, selected: question.correct.slice(1) };
}

/** 构造恰好 correctCount 题正确的答卷。 */
export function answersWithCorrect(correctCount: number): Answer[] {
  return FIXED_EXAM.map((question, index) =>
    index < correctCount ? { questionId: question.id, selected: [...question.correct] } : wrongAnswer(index),
  );
}

export const ALL_CORRECT: Answer[] = answersWithCorrect(FIXED_EXAM.length);

export function certFiles(dir: string): string[] {
  return readdirSync(join(dir, 'certificates'));
}

export function readCertFile(dir: string, certificateId: string): Certificate {
  return JSON.parse(readFileSync(join(dir, 'certificates', `${certificateId}.json`), 'utf8'));
}
