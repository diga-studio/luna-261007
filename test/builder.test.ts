import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuilder } from '../src/index.js';
import type { FileTree, Plan, RunFn, RunOutput } from '../src/index.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

function tempCacheDir(): string {
  return mkdtempSync(join(tmpdir(), 'layer-cache-'));
}

/** 记录调用并按命令路由到处理器的 run 实现。 */
function recorder(handlers: Record<string, (tree: FileTree) => RunOutput>): {
  calls: string[];
  run: RunFn;
} {
  const calls: string[] = [];
  const run: RunFn = async (command, tree) => {
    calls.push(command);
    const handler = handlers[command];
    if (handler === undefined) throw new Error(`unexpected command: ${command}`);
    return handler(tree);
  };
  return { calls, run };
}

const count = (calls: readonly string[], command: string): number =>
  calls.filter((c) => c === command).length;

test('两个分支共用来源阶段：未选中文件的修改不触发另一分支重建', async () => {
  const cacheDir = tempCacheDir();
  try {
    // 256 字节的二进制文件，覆盖全部字节值。
    const bin = Uint8Array.from({ length: 256 }, (_, i) => i);

    const { calls, run } = recorder({
      prepare: (tree) => ({
        writes: new Map<string, Uint8Array>([
          ['/out/selected.txt', tree.get('/src/selected.txt')!],
          ['/out/other.txt', tree.get('/src/other.txt')!],
          ['/out/bin.dat', bin],
        ]),
      }),
      'build-a': (tree) => ({
        writes: new Map<string, Uint8Array>([['/app/a.txt', tree.get('/app/selected.txt')!]]),
      }),
      'build-b': (tree) => ({
        writes: new Map<string, Uint8Array>([['/app/b.txt', tree.get('/app/other.txt')!]]),
      }),
    });

    const builder = createBuilder({ cacheDir, run });

    const plan: Plan = {
      stages: [
        {
          name: 'source',
          steps: [
            { type: 'copy', source: '/src', dest: '/src' },
            { type: 'run', command: 'prepare' },
          ],
        },
        {
          name: 'branch-a',
          steps: [
            { type: 'copy', from: 'source', source: '/out/selected.txt', dest: '/app/selected.txt' },
            { type: 'copy', from: 'source', source: '/out/bin.dat', dest: '/app/bin.dat' },
            { type: 'run', command: 'build-a' },
          ],
        },
        {
          name: 'branch-b',
          steps: [
            { type: 'copy', from: 'source', source: '/out/other.txt', dest: '/app/other.txt' },
            { type: 'run', command: 'build-b' },
          ],
        },
      ],
    };

    const contextV1: FileTree = new Map([
      ['/src/selected.txt', enc('selected-v1')],
      ['/src/other.txt', enc('other-v1')],
    ]);

    const imageA1 = await builder.build(plan, contextV1, 'branch-a');
    deepEqual(calls, ['prepare', 'build-a']);

    const imageB1 = await builder.build(plan, contextV1, 'branch-b');
    deepEqual(calls, ['prepare', 'build-a', 'build-b']);

    // 逐字节验证二进制文件。
    deepEqual(await builder.readFile(imageA1, '/app/bin.dat'), bin);
    deepEqual(await builder.readFile(imageA1, '/app/selected.txt'), enc('selected-v1'));
    deepEqual(await builder.readFile(imageB1, '/app/other.txt'), enc('other-v1'));

    // 修改只被 branch-a 选中的文件。
    const contextV2: FileTree = new Map([
      ['/src/selected.txt', enc('selected-v2')],
      ['/src/other.txt', enc('other-v1')],
    ]);

    const imageA2 = await builder.build(plan, contextV2, 'branch-a');
    equal(count(calls, 'prepare'), 2);
    equal(count(calls, 'build-a'), 2);
    equal(calls.length, 5);
    ok(imageA2 !== imageA1);
    deepEqual(await builder.readFile(imageA2, '/app/selected.txt'), enc('selected-v2'));

    // 另一分支不得重建：prepare 命中 branch-a 构建时的缓存，build-b 输入未变也命中。
    const imageB2 = await builder.build(plan, contextV2, 'branch-b');
    equal(count(calls, 'prepare'), 2); // contextV2 的 prepare 已在 branch-a 构建时跑过
    equal(count(calls, 'build-b'), 1); // build-b 输入未变，必须命中缓存
    equal(calls.length, 5);
    equal(imageB2, imageB1); // 最终树相同，imageId 相同
    deepEqual(await builder.readFile(imageB2, '/app/other.txt'), enc('other-v1'));
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('来源 RUN 换命令但输出相同则下游不重建；输出减文件则下游失效；缓存跨实例保留', async () => {
  const cacheDir = tempCacheDir();
  try {
    const sourceOutputV12 = (): RunOutput => ({
      writes: new Map<string, Uint8Array>([
        ['/out/keep.txt', enc('keep')],
        ['/out/extra.txt', enc('extra')],
      ]),
    });

    const { calls, run } = recorder({
      'gen-v1': sourceOutputV12,
      'gen-v2': sourceOutputV12, // 命令不同，输出树相同
      'gen-v3': () => ({
        writes: new Map<string, Uint8Array>([['/out/keep.txt', enc('keep')]]),
      }),
      consume: (tree) => ({
        writes: new Map<string, Uint8Array>([
          ['/app/result.txt', enc([...tree.keys()].sort().join('\n'))],
        ]),
      }),
    });

    const makePlan = (genCommand: string): Plan => ({
      stages: [
        { name: 'source', steps: [{ type: 'run', command: genCommand }] },
        {
          name: 'down',
          steps: [
            { type: 'copy', from: 'source', source: '/out', dest: '/app' },
            { type: 'run', command: 'consume' },
          ],
        },
      ],
    });

    const context: FileTree = new Map();
    const builder = createBuilder({ cacheDir, run });

    const image1 = await builder.build(makePlan('gen-v1'), context, 'down');
    deepEqual(calls, ['gen-v1', 'consume']);
    deepEqual(await builder.readFile(image1, '/app/extra.txt'), enc('extra'));

    // 换命令但输出树相同：gen 重跑（命令是缓存键的一部分），consume 命中。
    const image2 = await builder.build(makePlan('gen-v2'), context, 'down');
    equal(count(calls, 'gen-v2'), 1);
    equal(count(calls, 'consume'), 1); // 下游不得重建
    equal(calls.length, 3);
    equal(image2, image1); // 最终树相同，imageId 相同

    // 换命令且选中目录少一个文件：下游失效，最终文件缺失。
    const image3 = await builder.build(makePlan('gen-v3'), context, 'down');
    equal(count(calls, 'gen-v3'), 1);
    equal(count(calls, 'consume'), 2); // 输入树变了，必须重跑
    equal(calls.length, 5);
    ok(image3 !== image1);
    deepEqual(await builder.readFile(image3, '/app/keep.txt'), enc('keep'));
    equal(await builder.readFile(image3, '/app/extra.txt'), undefined);

    // 重新创建实例（同一缓存目录）：不再调用 run，输出仍可读。
    const calls2: string[] = [];
    const builder2 = createBuilder({
      cacheDir,
      run: async (command) => {
        calls2.push(command);
        throw new Error(`run must not be called, got: ${command}`);
      },
    });
    const image4 = await builder2.build(makePlan('gen-v3'), context, 'down');
    deepEqual(calls2, []);
    equal(image4, image3);
    deepEqual(await builder2.readFile(image4, '/app/keep.txt'), enc('keep'));
    equal(await builder2.readFile(image4, '/app/extra.txt'), undefined);
    deepEqual(await builder2.readFile(image4, '/app/result.txt'), await builder.readFile(image3, '/app/result.txt'));
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('RUN 删除效果随缓存完整还原；阶段改名与独立阶段重排不失效', async () => {
  const cacheDir = tempCacheDir();
  try {
    const { calls, run } = recorder({
      cleanup: () => ({ deletes: ['/src/junk.txt'] }),
    });
    const context: FileTree = new Map([
      ['/src/keep.txt', enc('keep')],
      ['/src/junk.txt', enc('junk')],
    ]);

    // 两个独立分支，target 只依赖其中一个。
    const planV1: Plan = {
      stages: [
        { name: 'unrelated', steps: [{ type: 'run', command: 'never-used' }] },
        {
          name: 'base',
          steps: [
            { type: 'copy', source: '/src', dest: '/src' },
            { type: 'run', command: 'cleanup' },
          ],
        },
        {
          name: 'app',
          from: 'base',
          steps: [{ type: 'copy', source: '/src/keep.txt', dest: '/app/keep.txt' }],
        },
      ],
    };

    const builder = createBuilder({ cacheDir, run });
    const image1 = await builder.build(planV1, context, 'app');
    deepEqual(calls, ['cleanup']); // 未选中 unrelated，其 RUN 不执行
    equal(await builder.readFile(image1, '/app/keep.txt') === undefined, false);
    deepEqual(await builder.readFile(image1, '/app/keep.txt'), enc('keep'));

    // 新实例 + 阶段改名 + 独立阶段重排：不得调用 run，删除效果仍还原。
    const planV2: Plan = {
      stages: [
        {
          name: 'renamed-app',
          from: 'renamed-base',
          steps: [{ type: 'copy', source: '/src/keep.txt', dest: '/app/keep.txt' }],
        },
        { name: 'another-unrelated', steps: [{ type: 'run', command: 'never-used' }] },
        {
          name: 'renamed-base',
          steps: [
            { type: 'copy', source: '/src', dest: '/src' },
            { type: 'run', command: 'cleanup' },
          ],
        },
      ],
    };

    const calls2: string[] = [];
    const builder2 = createBuilder({
      cacheDir,
      run: async (command) => {
        calls2.push(command);
        throw new Error(`run must not be called, got: ${command}`);
      },
    });
    const image2 = await builder2.build(planV2, context, 'renamed-app');
    deepEqual(calls2, []);
    equal(image2, image1); // 最终树相同，imageId 相同
    deepEqual(await builder2.readFile(image2, '/app/keep.txt'), enc('keep'));

    // 直接验证含删除的中间层也被完整还原：构建 renamed-base 自身。
    const baseImage = await builder2.build(planV2, context, 'renamed-base');
    deepEqual(calls2, []);
    deepEqual(await builder2.readFile(baseImage, '/src/keep.txt'), enc('keep'));
    equal(await builder2.readFile(baseImage, '/src/junk.txt'), undefined); // 删除效果保留
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
