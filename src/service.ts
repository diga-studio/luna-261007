import { randomUUID } from 'node:crypto';
import {
  COOLDOWN_MS,
  EXAM_DURATION_MS,
  FIXED_EXAM,
  MAX_ATTEMPTS,
  PASS_DENOMINATOR,
  PASS_NUMERATOR,
} from './exam.js';
import { CertificateStore } from './certificates.js';
import { FaultInjector, NO_FAULTS } from './faults.js';
import { Ledger } from './storage.js';
import type { SubmissionRow } from './storage.js';
import {
  ExamError,
  type Answer,
  type AttemptResult,
  type BeginResult,
  type Certificate,
  type SubmitResult,
} from './types.js';

export interface ExamServiceOptions {
  faults?: FaultInjector;
}

interface Score {
  correctCount: number;
  totalCount: number;
}

function grade(answers: Answer[]): Score {
  const selectedByQuestion = new Map(answers.map((a) => [a.questionId, a.selected]));
  let correctCount = 0;
  for (const question of FIXED_EXAM) {
    const selected = selectedByQuestion.get(question.id) ?? [];
    const selectedSet = new Set(selected);
    if (selectedSet.size !== selected.length) continue;
    const correctSet = new Set(question.correct);
    if (selectedSet.size !== correctSet.size) continue;
    if ([...correctSet].every((id) => selectedSet.has(id))) correctCount += 1;
  }
  return { correctCount, totalCount: FIXED_EXAM.length };
}

/** 通过判定：正确题数占比 >= 70%，整数比较，不做四舍五入。 */
function isPass(score: Score): boolean {
  return score.correctCount * PASS_DENOMINATOR >= score.totalCount * PASS_NUMERATOR;
}

/**
 * 限时考核与本地证书签发服务。
 * 账本存于 <dir>/ledger.sqlite，证书存于 <dir>/certificates/*.json。
 */
export class ExamService {
  private readonly ledger: Ledger;
  private readonly certificates: CertificateStore;
  private readonly faults: FaultInjector;

  constructor(dir: string, options: ExamServiceOptions = {}) {
    this.ledger = new Ledger(dir);
    this.certificates = new CertificateStore(dir);
    this.faults = options.faults ?? NO_FAULTS;
  }

  close(): void {
    this.ledger.close();
  }

  begin(learnerId: string, operationId: string, now: number): BeginResult {
    const existing = this.ledger.getAttemptByOperation(operationId);
    if (existing) {
      return { attemptId: existing.attemptId, deadline: existing.deadline };
    }

    this.settleExpired(now);

    const attempts = this.ledger.listAttemptsByLearner(learnerId);
    if (attempts.some((a) => a.status === 'active')) {
      throw new ExamError('ATTEMPT_IN_PROGRESS', '学习者已有未结束的考核');
    }
    if (attempts.length >= MAX_ATTEMPTS) {
      throw new ExamError('MAX_ATTEMPTS_REACHED', `最多开始 ${MAX_ATTEMPTS} 次考核`);
    }
    const lastSettledAt = this.lastSettledAt(learnerId);
    if (lastSettledAt !== undefined && now < lastSettledAt + COOLDOWN_MS) {
      throw new ExamError('COOLDOWN_ACTIVE', '距上一次考核结束不足 24 小时');
    }

    const attemptId = randomUUID();
    const deadline = now + EXAM_DURATION_MS;
    this.ledger.transaction(() => {
      this.ledger.insertAttempt({
        attemptId,
        learnerId,
        operationId,
        startedAt: now,
        deadline,
        status: 'active',
      });
    });
    this.faults.hit('begin:afterPersist');
    return { attemptId, deadline };
  }

  submit(attemptId: string, operationId: string, answers: Answer[], now: number): SubmitResult {
    const existing = this.ledger.getSubmissionByOperation(operationId);
    if (existing) {
      return this.toSubmitResult(existing);
    }

    const attempt = this.ledger.getAttempt(attemptId);
    if (!attempt) {
      throw new ExamError('ATTEMPT_NOT_FOUND', `考核不存在: ${attemptId}`);
    }
    if (attempt.status !== 'active') {
      throw new ExamError('ATTEMPT_ALREADY_SETTLED', `考核已结束: ${attemptId}`);
    }

    const valid = now < attempt.deadline;
    const score = grade(answers);
    const passed = valid && isPass(score);
    const certificateId = passed ? randomUUID() : null;
    const submission: SubmissionRow = {
      attemptId,
      operationId,
      answersJson: JSON.stringify(answers),
      submittedAt: now,
      valid: valid ? 1 : 0,
      correctCount: score.correctCount,
      totalCount: score.totalCount,
      passed: passed ? 1 : 0,
      certificateId,
    };
    this.ledger.transaction(() => {
      this.ledger.insertSubmission(submission);
      this.ledger.setAttemptStatus(attemptId, valid ? 'submitted' : 'timeout');
    });
    this.faults.hit('submit:afterSubmissionPersisted');

    if (passed && certificateId) {
      this.certificates.write({
        certificateId,
        attemptId,
        learnerId: attempt.learnerId,
        correctCount: score.correctCount,
        totalCount: score.totalCount,
        issuedAt: now,
      });
      this.faults.hit('submit:afterCertWritten');
    }
    return this.toSubmitResult(submission);
  }

  result(attemptId: string): AttemptResult {
    const attempt = this.ledger.getAttempt(attemptId);
    if (!attempt) {
      throw new ExamError('ATTEMPT_NOT_FOUND', `考核不存在: ${attemptId}`);
    }
    const submission = this.ledger.getSubmission(attemptId);
    const result: AttemptResult = {
      attemptId: attempt.attemptId,
      learnerId: attempt.learnerId,
      status: attempt.status,
      startedAt: attempt.startedAt,
      deadline: attempt.deadline,
    };
    if (submission) {
      result.submission = {
        submittedAt: submission.submittedAt,
        valid: submission.valid === 1,
        correctCount: submission.correctCount,
        totalCount: submission.totalCount,
        passed: submission.passed === 1,
        certificateId: submission.certificateId ?? undefined,
      };
      if (submission.passed === 1 && submission.certificateId) {
        const certificate = this.certificates.read(submission.certificateId);
        if (certificate) result.certificate = certificate;
      }
    }
    return result;
  }

  /** 恢复中断操作：结算超时考核，并以账本为准对账证书文件。 */
  recover(now: number): void {
    this.settleExpired(now);
    const expected: Certificate[] = this.ledger.listCertifiedSubmissions().map((submission) => {
      const attempt = this.ledger.getAttempt(submission.attemptId);
      return {
        certificateId: submission.certificateId as string,
        attemptId: submission.attemptId,
        learnerId: attempt?.learnerId ?? '',
        correctCount: submission.correctCount,
        totalCount: submission.totalCount,
        issuedAt: submission.submittedAt,
      };
    });
    this.certificates.reconcile(expected);
  }

  /** 将 deadline 已到且未提交的考核结算为超时。 */
  private settleExpired(now: number): void {
    const expired = this.ledger.listExpiredActiveAttempts(now);
    if (expired.length === 0) return;
    this.ledger.transaction(() => {
      for (const attempt of expired) {
        this.ledger.setAttemptStatus(attempt.attemptId, 'timeout');
      }
    });
  }

  /** 最近一次已结束考核的结算时间：有效提交时间或超时 deadline。 */
  private lastSettledAt(learnerId: string): number | undefined {
    let last: number | undefined;
    for (const attempt of this.ledger.listAttemptsByLearner(learnerId)) {
      if (attempt.status === 'active') continue;
      let settledAt = attempt.deadline;
      if (attempt.status === 'submitted') {
        const submission = this.ledger.getSubmission(attempt.attemptId);
        if (submission && submission.valid === 1) settledAt = submission.submittedAt;
      }
      if (last === undefined || settledAt > last) last = settledAt;
    }
    return last;
  }

  private toSubmitResult(submission: SubmissionRow): SubmitResult {
    const result: SubmitResult = {
      attemptId: submission.attemptId,
      passed: submission.passed === 1,
      timedOut: submission.valid === 0,
      correctCount: submission.correctCount,
      totalCount: submission.totalCount,
    };
    if (submission.certificateId) result.certificateId = submission.certificateId;
    return result;
  }
}

export { FaultInjector, NO_FAULTS };
