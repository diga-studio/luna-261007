import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExamService } from '../src/service.js';
import { FaultInjector, SimulatedCrash } from '../src/faults.js';
import type { CrashPoint } from '../src/faults.js';
import {
  ALL_CORRECT,
  HOUR,
  T0,
  certFiles,
  cleanDir,
  makeDir,
  readCertFile,
} from './helpers.js';

/** 在指定故障点崩溃：返回被“杀死”的服务（模拟进程终止，不 close）。 */
function crashAt(dir: string, point: CrashPoint, action: (svc: ExamService) => void): void {
  const faults = new FaultInjector();
  faults.arm(point);
  const svc = new ExamService(dir, { faults });
  assert.throws(() => action(svc), (e) => e instanceof SimulatedCrash && e.point === point);
  // 进程“死亡”：丢弃实例，不调用 close。
}

test('崩溃恢复：begin 已生效但未返回，恢复后重试返回原结果且不多占次数', () => {
  const dir = makeDir();
  try {
    let crashedDeadline = 0;
    crashAt(dir, 'begin:afterPersist', (svc) => {
      svc.begin('alice', 'op-b1', T0);
    });

    // 重开同一数据目录并恢复
    const svc = new ExamService(dir);
    try {
      svc.recover(T0 + 1);
      // 同一 operationId 重试（now 允许变化）→ 返回原 attemptId/deadline
      const retried = svc.begin('alice', 'op-b1', T0 + 5000);
      assert.equal(retried.deadline, T0 + 60 * 60 * 1000);
      crashedDeadline = retried.deadline;

      // 次数只被占用 1 次：之后还能再开始 2 次，第 4 次被拒绝
      svc.recover(crashedDeadline);
      let now = crashedDeadline + 24 * HOUR;
      const second = svc.begin('alice', 'op-b2', now);
      svc.recover(second.deadline);
      now = second.deadline + 24 * HOUR;
      const third = svc.begin('alice', 'op-b3', now);
      svc.recover(third.deadline);
      now = third.deadline + 24 * HOUR;
      assert.throws(() => svc.begin('alice', 'op-b4', now), /最多开始/);
    } finally {
      svc.close();
    }
  } finally {
    cleanDir(dir);
  }
});

test('崩溃恢复：答卷已在 deadline 前被持久接纳但证书未写，deadline 后恢复重试仍得原成绩', () => {
  const dir = makeDir();
  try {
    // 先正常 begin
    const setup = new ExamService(dir);
    const { attemptId, deadline } = setup.begin('alice', 'op-b1', T0);
    setup.close();

    // submit 在“答卷已持久接纳、证书尚未落盘”处崩溃
    crashAt(dir, 'submit:afterSubmissionPersisted', (svc) => {
      svc.submit(attemptId, 'op-s1', ALL_CORRECT, T0 + 1000);
    });
    assert.deepEqual(certFiles(dir), []);

    // deadline 之后重开并恢复，再重试同一 submit
    const svc = new ExamService(dir);
    try {
      svc.recover(deadline + 1000);
      const retried = svc.submit(attemptId, 'op-s1', ALL_CORRECT, deadline + 2000);
      assert.equal(retried.passed, true);
      assert.equal(retried.timedOut, false);
      assert.equal(retried.correctCount, 10);
      assert.ok(retried.certificateId);

      // recover 已按账本补写证书：恰好一份，内容匹配账本
      assert.deepEqual(certFiles(dir), [`${retried.certificateId}.json`]);
      const cert = readCertFile(dir, retried.certificateId!);
      assert.equal(cert.attemptId, attemptId);
      assert.equal(cert.learnerId, 'alice');
      assert.equal(cert.issuedAt, T0 + 1000);

      const view = svc.result(attemptId);
      assert.equal(view.status, 'submitted');
      assert.equal(view.submission?.passed, true);
      assert.deepEqual(view.certificate, cert);
    } finally {
      svc.close();
    }
  } finally {
    cleanDir(dir);
  }
});

test('崩溃恢复：证书已落盘但 submit 未返回，恢复后 certificateId 稳定且仅一份匹配证书', () => {
  const dir = makeDir();
  try {
    const setup = new ExamService(dir);
    const { attemptId, deadline } = setup.begin('alice', 'op-b1', T0);
    setup.close();

    crashAt(dir, 'submit:afterCertWritten', (svc) => {
      svc.submit(attemptId, 'op-s1', ALL_CORRECT, T0 + 1000);
    });
    const filesAfterCrash = certFiles(dir);
    assert.equal(filesAfterCrash.length, 1);
    const crashedCertId = filesAfterCrash[0]!.replace(/\.json$/, '');

    // 制造中断遗留：无主证书、不完整文件、临时文件、被篡改的正主证书
    const certsDir = join(dir, 'certificates');
    writeFileSync(join(certsDir, 'orphan-cert.json'), JSON.stringify({ certificateId: 'orphan-cert' }));
    writeFileSync(join(certsDir, 'broken.json'), '{"certificateId": "broken",');
    writeFileSync(join(certsDir, 'half-written.json.tmp'), '{"certificateId": "half');
    writeFileSync(join(certsDir, `${crashedCertId}.json`), '{"certificateId": "tampered"');

    const svc = new ExamService(dir);
    try {
      svc.recover(deadline + 1000);

      // 重试：返回原成绩，certificateId 与崩溃前落盘的证书一致
      const retried = svc.submit(attemptId, 'op-s1', ALL_CORRECT, deadline + 2000);
      assert.equal(retried.passed, true);
      assert.equal(retried.certificateId, crashedCertId);

      // 最终仅有一份完整且匹配账本的证书；遗留垃圾被清除
      assert.deepEqual(certFiles(dir), [`${crashedCertId}.json`]);
      const cert = readCertFile(dir, crashedCertId);
      assert.deepEqual(cert, {
        certificateId: crashedCertId,
        attemptId,
        learnerId: 'alice',
        correctCount: 10,
        totalCount: 10,
        issuedAt: T0 + 1000,
      });
      assert.deepEqual(svc.result(attemptId).certificate, cert);
    } finally {
      svc.close();
    }
  } finally {
    cleanDir(dir);
  }
});

test('崩溃恢复：失败答卷被持久接纳后崩溃，恢复重试仍得原失败结果且无证书', () => {
  const dir = makeDir();
  try {
    const setup = new ExamService(dir);
    const { attemptId, deadline } = setup.begin('alice', 'op-b1', T0);
    setup.close();

    const wrong = ALL_CORRECT.map((a, i) =>
      i < 4 ? { questionId: a.questionId, selected: ['zzz'] } : a,
    );
    crashAt(dir, 'submit:afterSubmissionPersisted', (svc) => {
      svc.submit(attemptId, 'op-s1', wrong, T0 + 1000);
    });

    const svc = new ExamService(dir);
    try {
      svc.recover(deadline + 1000);
      const retried = svc.submit(attemptId, 'op-s1', wrong, deadline + 2000);
      assert.equal(retried.passed, false);
      assert.equal(retried.correctCount, 6);
      assert.equal(retried.certificateId, undefined);
      assert.deepEqual(certFiles(dir), []);
    } finally {
      svc.close();
    }
  } finally {
    cleanDir(dir);
  }
});
