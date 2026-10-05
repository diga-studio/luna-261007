import { createHash } from "node:crypto";
import { CacheStore, type LayerRecord } from "./store.js";
import { cloneTree, hashBytes, hashTree, normalizePath, subtree } from "./tree.js";
import type {
  Builder,
  BuilderOptions,
  CopyStep,
  FileTree,
  MutableFileTree,
  Plan,
  RunResult,
  Stage,
  Step,
} from "./types.js";

function normalizeContext(context: FileTree): MutableFileTree {
  const tree: MutableFileTree = new Map();
  for (const [p, bytes] of context) {
    tree.set(normalizePath(p), bytes);
  }
  return tree;
}

function layerKey(command: string, inputHash: string): string {
  return createHash("sha256")
    .update("run\0", "utf8")
    .update(command, "utf8")
    .update("\0")
    .update(inputHash, "utf8")
    .digest("hex");
}

function normalizeRunResult(result: RunResult): {
  writes: Map<string, Uint8Array>;
  deletes: string[];
} {
  const writes = new Map<string, Uint8Array>();
  for (const [p, bytes] of Object.entries(result.writes)) {
    writes.set(normalizePath(p), bytes);
  }
  const deletes = [...new Set(result.deletes.map(normalizePath))];
  return { writes, deletes };
}

export function createBuilder(options: BuilderOptions): Builder {
  const store = new CacheStore(options.cacheDir);
  const run = options.run;

  async function applyRun(tree: MutableFileTree, command: string): Promise<void> {
    const inputHash = hashTree(tree);
    const key = layerKey(command, inputHash);
    const cached = await store.getLayer(key);
    if (cached !== undefined) {
      for (const p of cached.deletes) tree.delete(p);
      for (const [p, blobHash] of Object.entries(cached.writes)) {
        tree.set(p, await store.readBlob(blobHash));
      }
      return;
    }
    const result = normalizeRunResult(await run(command, new Map(tree)));
    const recordWrites: Record<string, string> = {};
    for (const [p, bytes] of result.writes) {
      const blobHash = hashBytes(bytes);
      if (!(await store.hasBlob(blobHash))) {
        await store.writeBlob(blobHash, bytes);
      }
      recordWrites[p] = blobHash;
    }
    const record: LayerRecord = { writes: recordWrites, deletes: result.deletes };
    await store.putLayer(key, record);
    for (const p of result.deletes) tree.delete(p);
    for (const [p, bytes] of result.writes) tree.set(p, bytes);
  }

  function applyCopy(
    tree: MutableFileTree,
    step: CopyStep,
    sourceTree: FileTree,
  ): void {
    const dest = normalizePath(step.dest);
    const srcs = typeof step.src === "string" ? [step.src] : step.src;
    for (const rawSrc of srcs) {
      const src = normalizePath(rawSrc);
      const file = sourceTree.get(src);
      if (file !== undefined) {
        tree.set(dest, file);
        continue;
      }
      const sub = subtree(sourceTree, src);
      if (sub.size === 0) {
        throw new Error(`copy source not found: ${rawSrc}`);
      }
      for (const [rel, bytes] of sub) {
        tree.set(dest === "/" ? `/${rel}` : `${dest}/${rel}`, bytes);
      }
    }
  }

  async function build(plan: Plan, context: FileTree, target: string): Promise<string> {
    const contextTree = normalizeContext(context);
    const stages = new Map<string, Stage>();
    for (const stage of plan.stages) {
      if (stages.has(stage.name)) {
        throw new Error(`duplicate stage name: ${stage.name}`);
      }
      stages.set(stage.name, stage);
    }
    if (!stages.has(target)) {
      throw new Error(`target stage not found: ${target}`);
    }

    const memo = new Map<string, Promise<MutableFileTree>>();
    const resolving = new Set<string>();

    async function evaluate(name: string): Promise<MutableFileTree> {
      const hit = memo.get(name);
      if (hit !== undefined) return hit;
      if (resolving.has(name)) {
        throw new Error(`stage dependency cycle at: ${name}`);
      }
      resolving.add(name);
      const promise = (async () => {
        const stage = stages.get(name);
        if (stage === undefined) {
          throw new Error(`stage not found: ${name}`);
        }
        const tree: MutableFileTree =
          stage.from !== undefined
            ? cloneTree(await evaluate(stage.from))
            : new Map();
        for (const step of stage.steps) {
          await applyStep(tree, step);
        }
        return tree;
      })();
      memo.set(name, promise);
      try {
        return await promise;
      } finally {
        resolving.delete(name);
      }
    }

    async function applyStep(tree: MutableFileTree, step: Step): Promise<void> {
      if (step.type === "copy") {
        const sourceTree =
          step.from !== undefined ? await evaluate(step.from) : contextTree;
        applyCopy(tree, step, sourceTree);
      } else {
        await applyRun(tree, step.command);
      }
    }

    const finalTree = await evaluate(target);

    const files: Record<string, string> = {};
    for (const [p, bytes] of [...finalTree.entries()].sort()) {
      const blobHash = hashBytes(bytes);
      if (!(await store.hasBlob(blobHash))) {
        await store.writeBlob(blobHash, bytes);
      }
      files[p] = blobHash;
    }
    const imageId = hashTree(finalTree);
    await store.putImage(imageId, files);
    return imageId;
  }

  async function readFile(
    imageId: string,
    path: string,
  ): Promise<Uint8Array | undefined> {
    const manifest = await store.getImage(imageId);
    if (manifest === undefined) return undefined;
    const blobHash = manifest[normalizePath(path)];
    if (blobHash === undefined) return undefined;
    return store.readBlob(blobHash);
  }

  return { build, readFile };
}
