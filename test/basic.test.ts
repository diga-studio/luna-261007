import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanup, makeRunner, sleep, waitForFile, waitForTerminal } from './helpers';

test('all steps succeed -> Passed, stdout/stderr saved separately', async () => {
  const ctx = await makeRunner();
  try {
    const runId = await ctx.runner.submit({
      stages: [
        {
          name: 'Build',
          steps: [
            { name: 'compile', command: 'sh', args: ['-c', 'echo out-1; echo err-1 1>&2'] },
            { name: 'package', command: 'sh', args: ['-c', 'echo out-2'] },
          ],
        },
        { name: 'Test', steps: [{ name: 'unit', command: 'sh', args: ['-c', 'exit 0'] }] },
      ],
    });
    const record = await waitForTerminal(ctx.runner, runId);
    assert.equal(record.status, 'Passed');

    const logs = ctx.runner.getLogs(runId);
    assert.equal(logs.length, 3);
    assert.deepEqual(logs.map((l) => l.step), ['compile', 'package', 'unit']);
    assert.equal(fs.readFileSync(logs[0].stdoutPath, 'utf8'), 'out-1\n');
    assert.equal(fs.readFileSync(logs[0].stderrPath, 'utf8'), 'err-1\n');
    assert.equal(fs.readFileSync(logs[1].stdoutPath, 'utf8'), 'out-2\n');
    assert.equal(fs.readFileSync(logs[1].stderrPath, 'utf8'), '');
  } finally {
    await ctx.runner.close();
    cleanup(ctx);
  }
});

test('non-zero exit -> Failed, later steps skipped', async () => {
  const ctx = await makeRunner();
  try {
    const marker = path.join(ctx.dir, 'later-ran');
    const runId = await ctx.runner.submit({
      stages: [
        {
          name: 'Build',
          steps: [
            { name: 'boom', command: 'sh', args: ['-c', 'echo failing 1>&2; exit 3'] },
            { name: 'later', command: 'sh', args: ['-c', `touch "${marker}"`] },
          ],
        },
      ],
    });
    const record = await waitForTerminal(ctx.runner, runId);
    assert.equal(record.status, 'Failed');
    assert.match(record.reason!, /exit/);
    assert.ok(!fs.existsSync(marker));
    assert.equal(ctx.runner.getLogs(runId).length, 1);
  } finally {
    await ctx.runner.close();
    cleanup(ctx);
  }
});

test('unstartable program -> Failed', async () => {
  const ctx = await makeRunner();
  try {
    const runId = await ctx.runner.submit({
      stages: [{ name: 'Build', steps: [{ name: 'nope', command: '/nonexistent/binary-xyz' }] }],
    });
    const record = await waitForTerminal(ctx.runner, runId);
    assert.equal(record.status, 'Failed');
    assert.match(record.reason!, /failed to start/);
  } finally {
    await ctx.runner.close();
    cleanup(ctx);
  }
});

test('queued run canceled before starting never runs any step', async () => {
  const ctx = await makeRunner(1);
  try {
    const blocker = path.join(ctx.dir, 'blocker-ready');
    const release = path.join(ctx.dir, 'release');
    const queuedMarker = path.join(ctx.dir, 'queued-ran');

    const first = await ctx.runner.submit({
      stages: [
        {
          name: 'Build',
          steps: [{ name: 'block', command: 'sh', args: ['-c', `touch "${blocker}"; while [ ! -f "${release}" ]; do sleep 0.02; done`] }],
        },
      ],
    });
    const second = await ctx.runner.submit({
      stages: [{ name: 'Build', steps: [{ name: 'queued', command: 'sh', args: ['-c', `touch "${queuedMarker}"`] }] }],
    });

    await waitForFile(blocker); // 第一个运行占住名额
    const cancelResult = ctx.runner.cancel(second);
    assert.equal(cancelResult.accepted, true);
    assert.equal(ctx.runner.getRun(second)!.status, 'Canceled');

    fs.writeFileSync(release, 'go');
    await waitForTerminal(ctx.runner, first);
    await sleep(300); // 给被跳过的运行留出“错误启动”的时间窗
    assert.ok(!fs.existsSync(queuedMarker), '已取消的排队运行没有启动任何步骤');
    assert.equal(ctx.runner.getRun(second)!.status, 'Canceled');
    assert.equal(ctx.runner.getLogs(second).length, 0);
  } finally {
    await ctx.runner.close();
    cleanup(ctx);
  }
});

test('run records persist in SQLite across runner instances', async () => {
  const ctx = await makeRunner();
  const dir = ctx.dir;
  try {
    const runId = await ctx.runner.submit({
      stages: [{ name: 'Deploy', steps: [{ name: 'go', command: 'sh', args: ['-c', 'exit 0'] }] }],
    });
    await waitForTerminal(ctx.runner, runId);
    await ctx.runner.close();

    const { PipelineRunner } = await import('../src/index');
    const reopened = new PipelineRunner({ dbPath: path.join(dir, 'runs.db'), logDir: path.join(dir, 'logs') });
    await reopened.init();
    const record = reopened.getRun(runId);
    assert.equal(record?.status, 'Passed');
    await reopened.close();
  } finally {
    cleanup(ctx);
  }
});
