import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { EXAM } from "./exam.js";
import { Ledger } from "./store.js";
import { CertificateStore } from "./certificates.js";
import type {
  Answers,
  AttemptRecord,
  BeginResult,
  Certificate,
  ExamServiceOptions,
  RecoverReport,
  ResultView,
  SubmitResult,
} from "./types.js";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

interface Grade {
  correctCount: number;
  totalCount: number;
  passed: boolean;
}

function gradeAnswers(answers: Answers): Grade {
  let correctCount = 0;
  for (const question of EXAM.questions) {
    const given = answers[question.id] ?? [];
    if (question.type === "single") {
      if (given.length === 1 && given[0] === question.correct[0]) {
        correctCount += 1;
      }
    } else {
      const givenSet = new Set(given);
      const correctSet = new Set(question.correct);
      if (
        givenSet.size === correctSet.size &&
        [...givenSet].every((option) => correctSet.has(option))
      ) {
        correctCount += 1;
      }
    }
  }
  const totalCount = EXAM.questions.length;
  const passed =
    correctCount * EXAM.passRatio.denominator >=
    totalCount * EXAM.passRatio.numerator;
  return { correctCount, totalCount, passed };
}

function certificateIdFor(attemptId: string): string {
  return `cert-${attemptId}`;
}

function buildCertificate(attempt: AttemptRecord): Certificate {
  if (
    attempt.submittedAt === null ||
    attempt.correctCount === null ||
    attempt.totalCount === null ||
    attempt.certificateId === null
  ) {
    throw new Error(`attempt ${attempt.attemptId} is not certifiable`);
  }
  return {
    certificateId: attempt.certificateId,
    attemptId: attempt.attemptId,
    learnerId: attempt.learnerId,
    examId: attempt.examId,
    correctCount: attempt.correctCount,
    totalCount: attempt.totalCount,
    passed: true,
    submittedAt: attempt.submittedAt,
    issuedAt: attempt.submittedAt,
  };
}

export class ExamService {
  private readonly ledger: Ledger;
  private readonly certificates: CertificateStore;
  private readonly hooks: ExamServiceOptions["hooks"];

  constructor(options: ExamServiceOptions) {
    fs.mkdirSync(options.dataDir, { recursive: true });
    this.ledger = new Ledger(path.join(options.dataDir, "ledger.db"));
    this.certificates = new CertificateStore(
      path.join(options.dataDir, "certificates"),
    );
    this.hooks = options.hooks;
  }

  close(): void {
    this.ledger.close();
  }

  private settleExpired(now: number): string[] {
    const settled: string[] = [];
    this.ledger.transaction(() => {
      for (const attempt of this.ledger.listAllAttempts()) {
        if (attempt.status === "active" && now >= attempt.deadline) {
          this.ledger.markTimeout(attempt.attemptId);
          settled.push(attempt.attemptId);
        }
      }
    });
    return settled;
  }

  begin(learnerId: string, operationId: string, now: number): BeginResult {
    const existing = this.ledger.getOperation("begin", operationId);
    if (existing !== null) {
      return existing as BeginResult;
    }

    this.settleExpired(now);

    const attempts = this.ledger.listAttemptsByLearner(learnerId);
    if (attempts.some((attempt) => attempt.status === "active")) {
      throw new Error(`learner ${learnerId} already has an active attempt`);
    }
    if (attempts.length >= MAX_ATTEMPTS) {
      throw new Error(
        `learner ${learnerId} reached the maximum of ${MAX_ATTEMPTS} attempts`,
      );
    }
    let cooldownBase: number | null = null;
    for (const attempt of attempts) {
      const finalizedAt =
        attempt.status === "submitted"
          ? attempt.submittedAt
          : attempt.status === "timeout"
            ? attempt.deadline
            : null;
      if (finalizedAt !== null) {
        cooldownBase =
          cooldownBase === null
            ? finalizedAt
            : Math.max(cooldownBase, finalizedAt);
      }
    }
    if (cooldownBase !== null && now < cooldownBase + COOLDOWN_MS) {
      throw new Error(
        `learner ${learnerId} is in cooldown until ${cooldownBase + COOLDOWN_MS}`,
      );
    }

    const result: BeginResult = {
      attemptId: `att-${randomUUID()}`,
      deadline: now + EXAM.durationMs,
    };
    this.ledger.transaction(() => {
      this.ledger.insertAttempt({
        attemptId: result.attemptId,
        learnerId,
        examId: EXAM.examId,
        status: "active",
        startedAt: now,
        deadline: result.deadline,
        submittedAt: null,
        answers: null,
        correctCount: null,
        totalCount: null,
        passed: null,
        certificateId: null,
      });
      this.ledger.recordOperation("begin", operationId, result);
    });
    this.hooks?.afterBeginPersist?.();
    return result;
  }

  submit(
    attemptId: string,
    operationId: string,
    answers: Answers,
    now: number,
  ): SubmitResult {
    const existing = this.ledger.getOperation("submit", operationId);
    if (existing !== null) {
      return existing as SubmitResult;
    }

    const attempt = this.ledger.getAttempt(attemptId);
    if (attempt === null) {
      throw new Error(`unknown attempt ${attemptId}`);
    }

    if (attempt.status === "submitted") {
      const result = this.completeSubmittedAttempt(attempt);
      this.ledger.recordOperation("submit", operationId, result);
      return result;
    }

    if (attempt.status === "timeout" || now >= attempt.deadline) {
      if (attempt.status === "active") {
        this.ledger.markTimeout(attemptId);
      }
      const result: SubmitResult = {
        attemptId,
        status: "timeout",
        passed: false,
        correctCount: 0,
        totalCount: EXAM.questions.length,
      };
      this.ledger.recordOperation("submit", operationId, result);
      return result;
    }

    const grade = gradeAnswers(answers);
    this.ledger.transaction(() => {
      this.ledger.markSubmitted(
        attemptId,
        now,
        answers,
        grade.correctCount,
        grade.totalCount,
        grade.passed,
      );
    });
    this.hooks?.afterSubmitPersist?.();

    const result: SubmitResult = {
      attemptId,
      status: "submitted",
      passed: grade.passed,
      correctCount: grade.correctCount,
      totalCount: grade.totalCount,
    };

    if (grade.passed) {
      const certificateId = certificateIdFor(attemptId);
      this.ledger.setCertificate(attemptId, certificateId);
      const persisted = this.ledger.getAttempt(attemptId);
      if (persisted === null) {
        throw new Error(`attempt ${attemptId} vanished`);
      }
      this.certificates.write(buildCertificate(persisted));
      this.hooks?.afterCertificateWrite?.();
      result.certificateId = certificateId;
    }

    this.ledger.recordOperation("submit", operationId, result);
    return result;
  }

  private completeSubmittedAttempt(attempt: AttemptRecord): SubmitResult {
    if (
      attempt.answers === null ||
      attempt.correctCount === null ||
      attempt.totalCount === null ||
      attempt.passed === null
    ) {
      throw new Error(`attempt ${attempt.attemptId} has incomplete ledger row`);
    }
    const result: SubmitResult = {
      attemptId: attempt.attemptId,
      status: "submitted",
      passed: attempt.passed,
      correctCount: attempt.correctCount,
      totalCount: attempt.totalCount,
    };
    if (attempt.passed) {
      const certificateId =
        attempt.certificateId ?? certificateIdFor(attempt.attemptId);
      if (attempt.certificateId === null) {
        this.ledger.setCertificate(attempt.attemptId, certificateId);
      }
      const persisted = this.ledger.getAttempt(attempt.attemptId);
      if (persisted === null) {
        throw new Error(`attempt ${attempt.attemptId} vanished`);
      }
      const expected = buildCertificate(persisted);
      const onDisk = this.certificates.read(certificateId);
      if (JSON.stringify(onDisk) !== JSON.stringify(expected)) {
        this.certificates.write(expected);
      }
      this.hooks?.afterCertificateWrite?.();
      result.certificateId = certificateId;
    }
    return result;
  }

  result(attemptId: string): ResultView {
    const attempt = this.ledger.getAttempt(attemptId);
    if (attempt === null) {
      throw new Error(`unknown attempt ${attemptId}`);
    }
    const certificate =
      attempt.certificateId === null
        ? null
        : this.certificates.read(attempt.certificateId);
    return { attempt, certificate };
  }

  recover(now: number): RecoverReport {
    const settledTimeouts = this.settleExpired(now);
    const removedOrphanCertificates: string[] = [];
    const repairedCertificates: string[] = [];

    const referenced = new Set<string>();
    for (const attempt of this.ledger.listAllAttempts()) {
      const certifiable =
        attempt.status === "submitted" && attempt.passed === true;
      if (!certifiable) {
        if (attempt.certificateId !== null) {
          this.ledger.clearCertificate(attempt.attemptId);
        }
        continue;
      }
      const certificateId =
        attempt.certificateId ?? certificateIdFor(attempt.attemptId);
      if (attempt.certificateId === null) {
        this.ledger.setCertificate(attempt.attemptId, certificateId);
      }
      referenced.add(certificateId);
      const persisted = this.ledger.getAttempt(attempt.attemptId);
      if (persisted === null) {
        continue;
      }
      const expected = buildCertificate(persisted);
      const onDisk = this.certificates.read(certificateId);
      if (JSON.stringify(onDisk) !== JSON.stringify(expected)) {
        this.certificates.write(expected);
        repairedCertificates.push(certificateId);
      }
    }

    for (const certificateId of this.certificates.listIds()) {
      if (!referenced.has(certificateId)) {
        this.certificates.remove(certificateId);
        removedOrphanCertificates.push(certificateId);
      }
    }

    return { settledTimeouts, removedOrphanCertificates, repairedCertificates };
  }
}
