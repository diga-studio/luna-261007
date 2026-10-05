import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { EXAM, ExamService } from "../src/index.js";
import type { Answers, FaultHooks } from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "exam-test-"));
}

function correctAnswers(): Answers {
  const answers: Answers = {};
  for (const question of EXAM.questions) {
    answers[question.id] = [...question.correct];
  }
  return answers;
}

function answersWithCorrectCount(count: number): Answers {
  const answers: Answers = {};
  EXAM.questions.forEach((question, index) => {
    answers[question.id] = index < count ? [...question.correct] : [];
  });
  return answers;
}

function certDir(dataDir: string): string {
  return path.join(dataDir, "certificates");
}

function certFiles(dataDir: string): string[] {
  return fs.readdirSync(certDir(dataDir)).filter((n) => n.endsWith(".json"));
}

test("begin returns attemptId and 60-minute deadline", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const result = service.begin("learner-1", "op-b1", T0);
  assert.ok(result.attemptId);
  assert.equal(result.deadline, T0 + 60 * 60 * 1000);
  service.close();
});

test("submit all correct answers passes and issues a certificate file", () => {
  const dataDir = makeDir();
  const service = new ExamService({ dataDir });
  const { attemptId } = service.begin("learner-1", "op-b1", T0);
  const result = service.submit(attemptId, "op-s1", correctAnswers(), T0 + 1000);
  assert.equal(result.status, "submitted");
  assert.equal(result.passed, true);
  assert.equal(result.correctCount, EXAM.questions.length);
  assert.ok(result.certificateId);
  const view = service.result(attemptId);
  assert.equal(view.attempt.status, "submitted");
  assert.equal(view.certificate?.certificateId, result.certificateId);
  assert.equal(certFiles(dataDir).length, 1);
  service.close();
});

test("submit exactly at deadline is treated as timeout", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const { attemptId, deadline } = service.begin("learner-1", "op-b1", T0);
  const result = service.submit(attemptId, "op-s1", correctAnswers(), deadline);
  assert.equal(result.status, "timeout");
  assert.equal(result.passed, false);
  assert.equal(result.certificateId, undefined);
  service.close();
});

test("pass threshold is exact 70 percent without rounding", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const first = service.begin("learner-1", "op-b1", T0);
  const passed = service.submit(
    first.attemptId,
    "op-s1",
    answersWithCorrectCount(7),
    T0 + 1000,
  );
  assert.equal(passed.passed, true);

  const second = service.begin("learner-2", "op-b2", T0);
  const failed = service.submit(
    second.attemptId,
    "op-s2",
    answersWithCorrectCount(6),
    T0 + 1000,
  );
  assert.equal(failed.passed, false);
  assert.equal(failed.certificateId, undefined);
  service.close();
});

test("single choice requires the unique correct option", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const answers = correctAnswers();
  const single = EXAM.questions.find((q) => q.type === "single");
  assert.ok(single);
  answers[single.id] = [single.correct[0] as string, "extra-option"];
  const { attemptId } = service.begin("learner-1", "op-b1", T0);
  const result = service.submit(attemptId, "op-s1", answers, T0 + 1000);
  assert.equal(result.correctCount, EXAM.questions.length - 1);
  service.close();
});

test("multiple choice requires exact set equality", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const multiple = EXAM.questions.find((q) => q.type === "multiple");
  assert.ok(multiple);

  const subset = correctAnswers();
  subset[multiple.id] = multiple.correct.slice(1);
  const first = service.begin("learner-1", "op-b1", T0);
  const subsetResult = service.submit(first.attemptId, "op-s1", subset, T0 + 1);
  assert.equal(subsetResult.correctCount, EXAM.questions.length - 1);

  const superset = correctAnswers();
  superset[multiple.id] = [...multiple.correct, "wrong-extra"];
  const second = service.begin("learner-2", "op-b2", T0);
  const supersetResult = service.submit(
    second.attemptId,
    "op-s2",
    superset,
    T0 + 1,
  );
  assert.equal(supersetResult.correctCount, EXAM.questions.length - 1);
  service.close();
});

test("a learner can hold only one active attempt", () => {
  const service = new ExamService({ dataDir: makeDir() });
  service.begin("learner-1", "op-b1", T0);
  assert.throws(() => service.begin("learner-1", "op-b2", T0 + 1));
  service.close();
});

test("at most 3 attempts per learner, begin consumes the quota", () => {
  const service = new ExamService({ dataDir: makeDir() });
  let now = T0;
  for (let i = 0; i < 3; i += 1) {
    const { attemptId } = service.begin("learner-1", `op-b${i}`, now);
    service.submit(attemptId, `op-s${i}`, answersWithCorrectCount(0), now + 1);
    now += DAY + 1000;
  }
  assert.throws(() => service.begin("learner-1", "op-b3", now));
  service.close();
});

test("24-hour cooldown starts from the last valid submission", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const { attemptId } = service.begin("learner-1", "op-b1", T0);
  service.submit(attemptId, "op-s1", correctAnswers(), T0 + 5000);
  assert.throws(() =>
    service.begin("learner-1", "op-b2", T0 + 5000 + DAY - 1),
  );
  const again = service.begin("learner-1", "op-b2", T0 + 5000 + DAY);
  assert.ok(again.attemptId);
  service.close();
});

test("24-hour cooldown starts from the timeout deadline", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const { deadline } = service.begin("learner-1", "op-b1", T0);
  service.recover(deadline);
  assert.throws(() => service.begin("learner-1", "op-b2", deadline + DAY - 1));
  const again = service.begin("learner-1", "op-b2", deadline + DAY);
  assert.ok(again.attemptId);
  service.close();
});

test("begin settles previously expired attempts", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const first = service.begin("learner-1", "op-b1", T0);
  const second = service.begin(
    "learner-1",
    "op-b2",
    first.deadline + DAY,
  );
  assert.ok(second.attemptId);
  const view = service.result(first.attemptId);
  assert.equal(view.attempt.status, "timeout");
  service.close();
});

test("retrying begin with the same operationId returns the original result", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const first = service.begin("learner-1", "op-b1", T0);
  const retry = service.begin("learner-1", "op-b1", T0 + 999);
  assert.deepEqual(retry, first);
  service.close();
});

test("retrying submit with the same operationId returns the original result", () => {
  const service = new ExamService({ dataDir: makeDir() });
  const { attemptId } = service.begin("learner-1", "op-b1", T0);
  const first = service.submit(attemptId, "op-s1", correctAnswers(), T0 + 10);
  const retry = service.submit(attemptId, "op-s1", correctAnswers(), T0 + 20);
  assert.deepEqual(retry, first);
  service.close();
});

test("recover settles expired attempts and failed/timeout attempts keep no certificate", () => {
  const dataDir = makeDir();
  const service = new ExamService({ dataDir });
  const expired = service.begin("learner-1", "op-b1", T0);
  const failed = service.begin("learner-2", "op-b2", T0);
  service.submit(failed.attemptId, "op-s2", answersWithCorrectCount(0), T0 + 1);
  const report = service.recover(T0 + 2 * HOUR);
  assert.deepEqual(report.settledTimeouts, [expired.attemptId]);
  assert.equal(service.result(expired.attemptId).attempt.status, "timeout");
  assert.equal(certFiles(dataDir).length, 0);
  service.close();
});

test("recover removes orphan and repairs mismatched certificate files", () => {
  const dataDir = makeDir();
  const service = new ExamService({ dataDir });
  const { attemptId } = service.begin("learner-1", "op-b1", T0);
  const submitted = service.submit(attemptId, "op-s1", correctAnswers(), T0 + 1);
  const certificateId = submitted.certificateId as string;

  fs.writeFileSync(path.join(certDir(dataDir), "cert-orphan.json"), "{}");
  fs.writeFileSync(
    path.join(certDir(dataDir), `${certificateId}.json`),
    '{"broken": tru',
  );

  const report = service.recover(T0 + 2);
  assert.deepEqual(report.removedOrphanCertificates, ["cert-orphan"]);
  assert.deepEqual(report.repairedCertificates, [certificateId]);
  assert.deepEqual(certFiles(dataDir), [`${certificateId}.json`]);
  const view = service.result(attemptId);
  assert.equal(view.certificate?.certificateId, certificateId);
  service.close();
});

test("crash after begin persists: recover and retry returns original without extra quota", () => {
  const dataDir = makeDir();
  const hooks: FaultHooks = {
    afterBeginPersist: () => {
      throw new Error("simulated crash");
    },
  };
  const crashed = new ExamService({ dataDir, hooks });
  assert.throws(() => crashed.begin("learner-1", "op-b1", T0));

  const service = new ExamService({ dataDir });
  service.recover(T0 + 1);
  const retried = service.begin("learner-1", "op-b1", T0 + 5000);
  assert.equal(retried.deadline, T0 + 60 * 60 * 1000);

  const view = service.result(retried.attemptId);
  assert.equal(view.attempt.status, "active");

  service.submit(retried.attemptId, "op-s1", correctAnswers(), T0 + 6000);
  let now = T0 + 6000 + DAY;
  for (let i = 0; i < 2; i += 1) {
    const attempt = service.begin("learner-1", `op-bx${i}`, now);
    service.submit(attempt.attemptId, `op-sx${i}`, correctAnswers(), now + 1);
    now += DAY + 1000;
  }
  assert.throws(() => service.begin("learner-1", "op-bx2", now));
  service.close();
});

test("crash after answers persisted: retry after deadline still yields original result", () => {
  const dataDir = makeDir();
  const hooks: FaultHooks = {
    afterSubmitPersist: () => {
      throw new Error("simulated crash");
    },
  };
  const crashed = new ExamService({ dataDir, hooks });
  const { attemptId, deadline } = crashed.begin("learner-1", "op-b1", T0);
  assert.throws(() =>
    crashed.submit(attemptId, "op-s1", correctAnswers(), T0 + 1000),
  );

  const service = new ExamService({ dataDir });
  service.recover(deadline + DAY);
  const retried = service.submit(
    attemptId,
    "op-s1",
    correctAnswers(),
    deadline + DAY,
  );
  assert.equal(retried.status, "submitted");
  assert.equal(retried.passed, true);
  assert.equal(retried.correctCount, EXAM.questions.length);
  assert.equal(retried.certificateId, `cert-${attemptId}`);
  assert.deepEqual(certFiles(dataDir), [`${retried.certificateId}.json`]);
  const view = service.result(attemptId);
  assert.equal(view.certificate?.certificateId, retried.certificateId);
  service.close();
});

test("crash after certificate write: single stable certificate matching the ledger", () => {
  const dataDir = makeDir();
  const hooks: FaultHooks = {
    afterCertificateWrite: () => {
      throw new Error("simulated crash");
    },
  };
  const crashed = new ExamService({ dataDir, hooks });
  const { attemptId, deadline } = crashed.begin("learner-1", "op-b1", T0);
  assert.throws(() =>
    crashed.submit(attemptId, "op-s1", correctAnswers(), T0 + 1000),
  );
  assert.equal(certFiles(dataDir).length, 1);

  const service = new ExamService({ dataDir });
  service.recover(deadline + DAY);
  const retried = service.submit(
    attemptId,
    "op-s1",
    correctAnswers(),
    deadline + DAY,
  );
  assert.equal(retried.passed, true);
  assert.equal(retried.certificateId, `cert-${attemptId}`);
  assert.deepEqual(certFiles(dataDir), [`${retried.certificateId}.json`]);

  const view = service.result(attemptId);
  assert.equal(view.attempt.certificateId, retried.certificateId);
  assert.equal(view.certificate?.certificateId, retried.certificateId);
  assert.equal(view.certificate?.attemptId, attemptId);

  const again = service.submit(
    attemptId,
    "op-s1",
    correctAnswers(),
    deadline + 2 * DAY,
  );
  assert.deepEqual(again, retried);
  assert.equal(certFiles(dataDir).length, 1);
  service.close();
});
