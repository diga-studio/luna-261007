import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExamService } from '../src/service.js';
import { ExamError } from '../src/types.js';
import { EXAM_DURATION_MS, FIXED_EXAM } from '../src/exam.js';
import {
  ALL_CORRECT,
  HOUR,
  T0,
  answersWithCorrect,
  certFiles,
  cleanDir,
  makeDir,
  readCertFile,
} from './helpers.js';

function withService(dir: string, fn: (svc: ExamService) => void): void {
  const svc = new ExamService(dir);
  try {
    fn(svc);
  } finally {
    svc.close();
  }
}

test('begin 返回 attemptId 与 60 分钟后的 deadline', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const r = svc.begin('alice', 'op-b1', T0);
      assert.ok(r.attemptId);
      assert.equal(r.deadline, T0 + EXAM_DURATION_MS);
      const view = svc.result(r.attemptId);
      assert.equal(view.status, 'active');
      assert.equal(view.learnerId, 'alice');
    });
  } finally {
    cleanDir(dir);
  }
});

test('通过：70% 边界（7/10）即通过并签发证书，证书内容匹配账本', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const { attemptId } = svc.begin('alice', 'op-b1', T0);
      const r = svc.submit(attemptId, 'op-s1', answersWithCorrect(7), T0 + 1000);
      assert.equal(r.passed, true);
      assert.equal(r.timedOut, false);
      assert.equal(r.correctCount, 7);
      assert.equal(r.totalCount, FIXED_EXAM.length);
      assert.ok(r.certificateId);

      const files = certFiles(dir);
      assert.deepEqual(files, [`${r.certificateId}.json`]);
      const cert = readCertFile(dir, r.certificateId!);
      assert.equal(cert.attemptId, attemptId);
      assert.equal(cert.learnerId, 'alice');
      assert.equal(cert.correctCount, 7);
      assert.equal(cert.issuedAt, T0 + 1000);

      const view = svc.result(attemptId);
      assert.equal(view.status, 'submitted');
      assert.equal(view.submission?.passed, true);
      assert.deepEqual(view.certificate, cert);
    });
  } finally {
    cleanDir(dir);
  }
});

test('不通过：6/10 失败且不留下证书（不四舍五入）', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const { attemptId } = svc.begin('alice', 'op-b1', T0);
      const r = svc.submit(attemptId, 'op-s1', answersWithCorrect(6), T0 + 1000);
      assert.equal(r.passed, false);
      assert.equal(r.certificateId, undefined);
      assert.deepEqual(certFiles(dir), []);
      assert.equal(svc.result(attemptId).certificate, undefined);
    });
  } finally {
    cleanDir(dir);
  }
});

test('多选必须与正确集合完全相等', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const { attemptId } = svc.begin('alice', 'op-b1', T0);
      // 全部答对，但 q7（多选）多选一个错误选项 → 该题判错，9/10 仍通过
      const answers = ALL_CORRECT.map((a) =>
        a.questionId === 'q7' ? { questionId: 'q7', selected: [...a.selected, 'x'] } : a,
      );
      const r = svc.submit(attemptId, 'op-s1', answers, T0 + 1000);
      assert.equal(r.correctCount, 9);
      assert.equal(r.passed, true);
    });
  } finally {
    cleanDir(dir);
  }
});

test('超时：deadline 时刻及之后提交按超时失败处理', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const { attemptId, deadline } = svc.begin('alice', 'op-b1', T0);
      const r = svc.submit(attemptId, 'op-s1', ALL_CORRECT, deadline);
      assert.equal(r.passed, false);
      assert.equal(r.timedOut, true);
      assert.equal(r.certificateId, undefined);
      assert.deepEqual(certFiles(dir), []);
      assert.equal(svc.result(attemptId).status, 'timeout');
    });
  } finally {
    cleanDir(dir);
  }
});

test('recover 结算未提交的超时考核，冷却期自 deadline 起算', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const { attemptId, deadline } = svc.begin('alice', 'op-b1', T0);
      svc.recover(deadline + 1);
      assert.equal(svc.result(attemptId).status, 'timeout');
      assert.throws(
        () => svc.begin('alice', 'op-b2', deadline + 24 * HOUR - 1),
        (e) => e instanceof ExamError && e.code === 'COOLDOWN_ACTIVE',
      );
      const next = svc.begin('alice', 'op-b2', deadline + 24 * HOUR);
      assert.ok(next.attemptId);
    });
  } finally {
    cleanDir(dir);
  }
});

test('冷却期自前一次有效提交时间起算 24 小时', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const { attemptId } = svc.begin('alice', 'op-b1', T0);
      const submittedAt = T0 + 10 * 60 * 1000;
      svc.submit(attemptId, 'op-s1', answersWithCorrect(6), submittedAt);
      assert.throws(
        () => svc.begin('alice', 'op-b2', submittedAt + 24 * HOUR - 1),
        (e) => e instanceof ExamError && e.code === 'COOLDOWN_ACTIVE',
      );
      assert.ok(svc.begin('alice', 'op-b2', submittedAt + 24 * HOUR).attemptId);
    });
  } finally {
    cleanDir(dir);
  }
});

test('每名学习者同时只能有一次未结束考核', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      svc.begin('alice', 'op-b1', T0);
      assert.throws(
        () => svc.begin('alice', 'op-b2', T0 + 1),
        (e) => e instanceof ExamError && e.code === 'ATTEMPT_IN_PROGRESS',
      );
      // 其他学习者不受影响
      assert.ok(svc.begin('bob', 'op-b3', T0 + 1).attemptId);
    });
  } finally {
    cleanDir(dir);
  }
});

test('最多开始 3 次，开始即占用次数', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      let now = T0;
      for (let i = 0; i < 3; i += 1) {
        const { attemptId, deadline } = svc.begin('alice', `op-b${i}`, now);
        assert.equal(svc.result(attemptId).status, 'active');
        svc.recover(deadline); // 不提交，按超时结算
        now = deadline + 24 * HOUR;
      }
      assert.throws(
        () => svc.begin('alice', 'op-b3', now),
        (e) => e instanceof ExamError && e.code === 'MAX_ATTEMPTS_REACHED',
      );
    });
  } finally {
    cleanDir(dir);
  }
});

test('begin 幂等：同一 operationId 重试返回原结果且不多占次数', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const first = svc.begin('alice', 'op-b1', T0);
      const retry = svc.begin('alice', 'op-b1', T0 + 5000);
      assert.deepEqual(retry, first);
      // 占用次数仍为 1：结算后还能再开始 2 次
      svc.recover(first.deadline);
      svc.begin('alice', 'op-b2', first.deadline + 24 * HOUR);
      svc.recover(T0 + 2 * EXAM_DURATION_MS + 24 * HOUR);
    });
  } finally {
    cleanDir(dir);
  }
});

test('submit 幂等：重试返回原成绩与同一 certificateId', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const { attemptId } = svc.begin('alice', 'op-b1', T0);
      const first = svc.submit(attemptId, 'op-s1', ALL_CORRECT, T0 + 1000);
      const retry = svc.submit(attemptId, 'op-s1', ALL_CORRECT, T0 + 2000);
      assert.deepEqual(retry, first);
      assert.deepEqual(certFiles(dir), [`${first.certificateId}.json`]);
    });
  } finally {
    cleanDir(dir);
  }
});

test('已结束考核上的新 submit 请求被拒绝', () => {
  const dir = makeDir();
  try {
    withService(dir, (svc) => {
      const { attemptId } = svc.begin('alice', 'op-b1', T0);
      svc.submit(attemptId, 'op-s1', ALL_CORRECT, T0 + 1000);
      assert.throws(
        () => svc.submit(attemptId, 'op-s2', ALL_CORRECT, T0 + 2000),
        (e) => e instanceof ExamError && e.code === 'ATTEMPT_ALREADY_SETTLED',
      );
      assert.throws(
        () => svc.submit('no-such-attempt', 'op-s3', ALL_CORRECT, T0),
        (e) => e instanceof ExamError && e.code === 'ATTEMPT_NOT_FOUND',
      );
    });
  } finally {
    cleanDir(dir);
  }
});
