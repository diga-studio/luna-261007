import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanup, fileSize, makeRunner, sleep, waitForFile, waitForTerminal } from './helpers';

function writeScript(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

// 场景一：存在后代进程时取消 —— 后代全部停止、后续步骤不执行、终态为 Canceled、日志终态后不变。
test('cancel stops descendant processes and prevents later steps', async () => {
  const ctx = await makeRunner();
  try {
    const writerOut = path.join(ctx.dir, 'writer.log');
    const delayedMarker = path.join(ctx.dir, 'descendant-survived');
    const step2Marker = path.join(ctx.dir, 'step2-ran');
    // 后代 1：持续写自己的文件，同时向步骤 stdout 输出。
    const writer = writeScript(ctx.dir, 'writer.sh', `while true; do echo tick; echo tick >> "${writerOut}"; sleep 0.1; done\n`);
    // 后代 2：4 秒后留标记 —— 若取消没杀掉它，标记会出现。
    const delayed = writeScript(ctx.dir, 'delayed.sh', `sleep 4; touch "${delayedMarker}"\n`);

    const runId = await ctx.runner.submit({
      stages: [
        {
          name: 'Build',
          steps: [
            { name: 'spawn-descendants', command: 'sh', args: ['-c', `sh "${writer}" & sh "${delayed}" & wait`] },
            { name: 'never-reached', command: 'sh', args: ['-c', `echo ran > "${step2Marker}"`] },
          ],
        },
      ],
    });

    await waitForFile(writerOut); // 后代已开始写文件
    const cancelResult = ctx.runner.cancel(runId);
    assert.equal(cancelResult.accepted, true);

    const record = await waitForTerminal(ctx.runner, runId);
    assert.equal(record.status, 'Canceled', '受理取消后最终状态只能是 Canceled');

    assert.ok(!fs.existsSync(step2Marker), '后续步骤没有执行');
    assert.ok(!fs.existsSync(delayedMarker), '后代进程已被停止');

    // 后代写的文件不再增长。
    const size1 = fileSize(writerOut);
    await sleep(600);
    assert.equal(fileSize(writerOut), size1, '取消后后代不再写文件');

    // 等过后代原本的存活窗口，确认它确实被杀而不是仍在潜伏。
    await sleep(4000);
    assert.ok(!fs.existsSync(delayedMarker), '延迟后代没有存活到执行写操作');

    // 终态后日志不再增长。
    const logs = ctx.runner.getLogs(runId);
    assert.equal(logs.length, 1, '只记录了第一个步骤的日志');
    const stdoutSize = fileSize(logs[0].stdoutPath);
    assert.ok(stdoutSize > 0, '终止前收到的 stdout 已保存');
    await sleep(400);
    assert.equal(fileSize(logs[0].stdoutPath), stdoutSize, '终态后日志不再增长');

    // 终态后的取消不受理。
    assert.equal(ctx.runner.cancel(runId).accepted, false);
  } finally {
    await ctx.runner.close();
    cleanup(ctx);
  }
});

// 场景二：步骤退出与取消同时发生 —— 取消获胜，终态只有 Canceled。
test('cancel racing with step exit still ends in Canceled', async () => {
  const ctx = await makeRunner();
  try {
    const ready = path.join(ctx.dir, 'ready');
    const go = path.join(ctx.dir, 'go');
    const step2Marker = path.join(ctx.dir, 'step2-ran');

    const runId = await ctx.runner.submit({
      stages: [
        {
          name: 'Test',
          steps: [
            {
              name: 'wait-then-exit-zero',
              command: 'sh',
              args: ['-c', `touch "${ready}"; while [ ! -f "${go}" ]; do sleep 0.02; done; echo exiting-ok; exit 0`],
            },
            { name: 'never-reached', command: 'sh', args: ['-c', `echo ran > "${step2Marker}"`] },
          ],
        },
      ],
    });

    await waitForFile(ready); // 步骤正在运行
    const cancelResult = ctx.runner.cancel(runId); // 受理取消
    assert.equal(cancelResult.accepted, true);
    fs.writeFileSync(go, 'go'); // 同时让步骤以退出码 0 结束（迟到的成功通知）

    const record = await waitForTerminal(ctx.runner, runId);
    assert.equal(record.status, 'Canceled', '取消与成功退出竞争时，终态必须是 Canceled');

    assert.ok(!fs.existsSync(step2Marker), '后续步骤没有执行');

    // 终态后日志不变。
    const logs = ctx.runner.getLogs(runId);
    assert.equal(logs.length, 1);
    const sizes = [fileSize(logs[0].stdoutPath), fileSize(logs[0].stderrPath)];
    await sleep(400);
    assert.equal(fileSize(logs[0].stdoutPath), sizes[0]);
    assert.equal(fileSize(logs[0].stderrPath), sizes[1]);

    // 重复取消不重复清理，且终态不受理。
    assert.equal(ctx.runner.cancel(runId).accepted, false);
    assert.equal(ctx.runner.getRun(runId)!.status, 'Canceled');
  } finally {
    await ctx.runner.close();
    cleanup(ctx);
  }
});
