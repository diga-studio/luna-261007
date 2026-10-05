import { createHash } from 'node:crypto';
import { Store } from './store.js';
import { applyRunOutput, copyInto, hashTree, normalizePath } from './tree.js';
import type { Builder, BuilderOptions, FileTree, Plan, Stage } from './types.js';

/** 创建构建器实例；缓存位于 cacheDir，跨实例保留。 */
export function createBuilder(options: BuilderOptions): Builder {
  const store = new Store(options.cacheDir);
  const ready = store.init();

  async function runLayer(command: string, input: FileTree): Promise<Map<string, Uint8Array>> {
    // 缓存键只由命令字符串与执行前文件树决定：
    // 与阶段名、阶段顺序、未被选中的来源文件均无关。
    const key = createHash('sha256')
      .update(command)
      .update(new Uint8Array([0]))
      .update(hashTree(input))
      .digest('hex');

    const cached = await store.getLayer(key);
    if (cached !== undefined) {
      const writes = new Map<string, Uint8Array>();
      let intact = true;
      for (const [path, hash] of Object.entries(cached.writes)) {
        const bytes = await store.getBlob(hash);
        if (bytes === undefined) {
          intact = false;
          break;
        }
        writes.set(path, bytes);
      }
      if (intact) {
        // 命中：从 blob 还原完整输出，包括删除效果。
        return applyRunOutput(input, { writes, deletes: cached.deletes });
      }
    }

    const output = await options.run(command, input);
    const writes = new Map<string, Uint8Array>();
    const recordWrites: Record<string, string> = {};
    for (const [raw, bytes] of output.writes ?? []) {
      const path = normalizePath(raw);
      writes.set(path, bytes);
      recordWrites[path] = await store.putBlob(bytes);
    }
    const deletes = (output.deletes ?? []).map(normalizePath);
    await store.putLayer(key, { writes: recordWrites, deletes });
    return applyRunOutput(input, { writes, deletes });
  }

  return {
    async build(plan: Plan, context: FileTree, target: string): Promise<string> {
      await ready;

      const contextTree = new Map<string, Uint8Array>();
      for (const [path, bytes] of context) {
        contextTree.set(normalizePath(path), bytes);
      }

      const stages = new Map<string, Stage>();
      for (const stage of plan.stages) {
        if (stages.has(stage.name)) throw new Error(`duplicate stage: ${stage.name}`);
        stages.set(stage.name, stage);
      }

      const finals = new Map<string, Map<string, Uint8Array>>();
      async function buildStage(name: string, visiting: ReadonlySet<string>): Promise<Map<string, Uint8Array>> {
        const memo = finals.get(name);
        if (memo !== undefined) return memo;
        const stage = stages.get(name);
        if (stage === undefined) throw new Error(`unknown stage: ${name}`);
        if (visiting.has(name)) throw new Error(`stage cycle involving: ${name}`);
        const nextVisiting = new Set(visiting).add(name);

        let tree = stage.from === undefined
          ? new Map<string, Uint8Array>()
          : new Map(await buildStage(stage.from, nextVisiting));

        for (const step of stage.steps) {
          if (step.type === 'copy') {
            const source = step.from === undefined
              ? contextTree
              : await buildStage(step.from, nextVisiting);
            tree = copyInto(tree, source, step.source, step.dest);
          } else {
            tree = await runLayer(step.command, tree);
          }
        }

        finals.set(name, tree);
        return tree;
      }

      const finalTree = await buildStage(target, new Set());

      const files: Record<string, string> = {};
      for (const [path, bytes] of [...finalTree.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        files[path] = await store.putBlob(bytes);
      }
      return store.putImage(files);
    },

    async readFile(imageId: string, path: string): Promise<Uint8Array | undefined> {
      await ready;
      const image = await store.getImage(imageId);
      if (image === undefined) return undefined;
      const hash = image[normalizePath(path)];
      if (hash === undefined) return undefined;
      return store.getBlob(hash);
    },
  };
}
