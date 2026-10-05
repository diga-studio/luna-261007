import test from "node:test";
import assert from "node:assert/strict";
import {
  ContentLibrary,
  MAX_CATEGORY_DEPTH,
  MAX_DIRECT_CATEGORIES,
  type ArticleInput,
  type CategoryId,
} from "../src/index.js";
import { computeExpectedCounts, makeRng } from "./helpers.js";

function buildTree(
  lib: ContentLibrary,
  parents: Map<CategoryId, CategoryId | null>,
  edges: ReadonlyArray<readonly [CategoryId, CategoryId | null]>,
): void {
  for (const [id, parent] of edges) {
    lib.addCategory(id, parent);
    parents.set(id, parent);
  }
}

function assertCountsMatch(
  lib: ContentLibrary,
  parents: ReadonlyMap<CategoryId, CategoryId | null>,
  articles: readonly ArticleInput[],
): void {
  const expected = computeExpectedCounts(parents, articles);
  for (const [categoryId, expectedCount] of expected) {
    assert.equal(
      lib.getCoverageCount(categoryId),
      expectedCount,
      `coverage mismatch for category ${categoryId}`,
    );
  }
}

test("迁移：文章同时归属迁移子树、旧祖先其他分支、新祖先其他分支", () => {
  const lib = new ContentLibrary();
  const parents = new Map<CategoryId, CategoryId | null>();
  // A 为旧祖先：A1 是待迁移子树（含子节点 A1a），A2 是旧祖先的其他分支。
  // B 为新祖先：B1 是新祖先的其他分支。
  buildTree(lib, parents, [
    ["A", null],
    ["A1", "A"],
    ["A1a", "A1"],
    ["A2", "A"],
    ["B", null],
    ["B1", "B"],
  ]);

  // X 同时命中三处：迁移子树内、旧祖先其他分支、新祖先其他分支。
  const articleX: ArticleInput = {
    id: "X",
    published: true,
    categoryIds: ["A1a", "A2", "B1"],
  };
  // Y 只归属迁移子树，迁移后应离开 A、进入 B。
  const articleY: ArticleInput = {
    id: "Y",
    published: true,
    categoryIds: ["A1a"],
  };
  lib.upsertArticle(articleX);
  lib.upsertArticle(articleY);

  assert.equal(lib.getCoverageCount("A"), 2, "X 命中 A1a 与 A2 只计一次");
  assert.equal(lib.getCoverageCount("B"), 1, "X 经 B1 计入 B");
  assert.equal(lib.getCoverageCount("A1"), 2);
  assert.equal(lib.getCoverageCount("A2"), 1);
  assert.equal(lib.getCoverageCount("B1"), 1);

  lib.moveCategory("A1", "B");
  parents.set("A1", "B");

  assert.equal(lib.getCoverageCount("A"), 1, "X 仍经 A2 命中旧祖先 A，不能漏计");
  assert.equal(lib.getCoverageCount("B"), 2, "X 经 B1 与子树命中 B 只计一次，不能重计");
  assert.equal(lib.getCoverageCount("A1"), 2, "子树内部计数不因迁移改变");
  assert.equal(lib.getCoverageCount("A1a"), 2);
  assert.equal(lib.getCoverageCount("A2"), 1);
  assert.equal(lib.getCoverageCount("B1"), 1);
  assertCountsMatch(lib, parents, [articleX, articleY]);
  lib.close();
});

test("归属替换与发布状态切换：重复提交幂等", () => {
  const lib = new ContentLibrary();
  const parents = new Map<CategoryId, CategoryId | null>();
  buildTree(lib, parents, [
    ["A", null],
    ["A1", "A"],
    ["B", null],
  ]);

  const draft: ArticleInput = { id: "P", published: false, categoryIds: ["A1"] };
  lib.upsertArticle(draft);
  assert.equal(lib.getCoverageCount("A"), 0, "未发布不参与统计");

  const published: ArticleInput = { id: "P", published: true, categoryIds: ["A1"] };
  lib.upsertArticle(published);
  lib.upsertArticle(published);
  lib.upsertArticle({ ...published });
  assert.equal(lib.getCoverageCount("A"), 1, "重复提交相同内容不改变计数");
  assert.equal(lib.getCoverageCount("A1"), 1);

  const moved: ArticleInput = { id: "P", published: true, categoryIds: ["B"] };
  lib.upsertArticle(moved);
  assert.equal(lib.getCoverageCount("A"), 0, "整体替换后旧归属不再计入");
  assert.equal(lib.getCoverageCount("B"), 1);

  const orphan: ArticleInput = { id: "P", published: true, categoryIds: [] };
  lib.upsertArticle(orphan);
  assert.equal(lib.getCoverageCount("B"), 0, "允许没有归属的文章");
  assertCountsMatch(lib, parents, [orphan]);
  lib.close();
});

test("约束校验：层级、归属数量、环与未知分类", () => {
  const lib = new ContentLibrary();
  buildTree(lib, new Map(), [
    ["L1", null],
    ["L2", "L1"],
    ["L3", "L2"],
    ["L4", "L3"],
  ]);
  assert.equal(MAX_CATEGORY_DEPTH, 4);
  assert.throws(() => lib.addCategory("L5", "L4"), /depth/);
  assert.throws(() => lib.addCategory("L1", null), /already exists/);
  assert.throws(() => lib.addCategory("X", "missing"), /unknown category/);

  lib.addCategory("T", null);
  lib.addCategory("T2", "T");
  assert.throws(() => lib.moveCategory("L1", "L4"), /descendant/);
  assert.throws(() => lib.moveCategory("L1", "L1"), /own parent/);
  assert.throws(() => lib.moveCategory("T", "L3"), /depth/);
  assert.throws(() => lib.moveCategory("missing", null), /unknown category/);

  lib.moveCategory("L4", null);
  assert.equal(lib.getCoverageCount("L4"), 0, "移到顶层后仍可读取");

  const tooMany = Array.from(
    { length: MAX_DIRECT_CATEGORIES + 1 },
    (_, i) => `c${i}`,
  );
  assert.throws(
    () => lib.upsertArticle({ id: "a", published: true, categoryIds: tooMany }),
    /at most/,
  );
  assert.throws(
    () => lib.upsertArticle({ id: "a", published: true, categoryIds: ["nope"] }),
    /unknown category/,
  );
  assert.throws(() => lib.getCoverageCount("nope"), /unknown category/);
  lib.close();
});

test("连续迁移与归属替换、发布切换混合：与逐篇重算的标准结果一致", () => {
  const rng = makeRng(20261007);
  const lib = new ContentLibrary();
  const parents = new Map<CategoryId, CategoryId | null>();
  const articles = new Map<string, ArticleInput>();

  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(rng() * items.length)]!;

  // 初始随机树：逐个挂到随机合法父节点下，保持不超过四层。
  const categoryIds: CategoryId[] = [];
  const depthOf = (id: CategoryId): number => {
    let depth = 1;
    let current = parents.get(id) ?? null;
    while (current !== null) {
      depth++;
      current = parents.get(current) ?? null;
    }
    return depth;
  };
  for (let i = 0; i < 24; i++) {
    const id = `C${i}`;
    const candidates = [null, ...categoryIds.filter((p) => depthOf(p) < 4)];
    const parent = pick(candidates);
    lib.addCategory(id, parent);
    parents.set(id, parent);
    categoryIds.push(id);
  }

  const subtreeOf = (root: CategoryId): Set<CategoryId> => {
    const scope = new Set<CategoryId>([root]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [child, parent] of parents) {
        if (parent !== null && scope.has(parent) && !scope.has(child)) {
          scope.add(child);
          grew = true;
        }
      }
    }
    return scope;
  };

  const randomCategories = (): CategoryId[] => {
    const size = Math.floor(rng() * (MAX_DIRECT_CATEGORIES + 1));
    const chosen = new Set<CategoryId>();
    while (chosen.size < size) chosen.add(pick(categoryIds));
    return [...chosen];
  };

  for (let step = 0; step < 300; step++) {
    if (rng() < 0.6) {
      const article: ArticleInput = {
        id: `P${Math.floor(rng() * 30)}`,
        published: rng() < 0.75,
        categoryIds: randomCategories(),
      };
      lib.upsertArticle(article);
      articles.set(article.id, article);
    } else {
      const id = pick(categoryIds);
      const forbidden = subtreeOf(id);
      const heightOf = (root: CategoryId): number => {
        let height = 1;
        for (const [child, parent] of parents) {
          if (parent === root) {
            height = Math.max(height, 1 + heightOf(child));
          }
        }
        return height;
      };
      const height = heightOf(id);
      const targets: Array<CategoryId | null> = [null];
      for (const candidate of categoryIds) {
        if (forbidden.has(candidate)) continue;
        if (depthOf(candidate) + height <= MAX_CATEGORY_DEPTH) {
          targets.push(candidate);
        }
      }
      const target = pick(targets);
      if (target !== parents.get(id)) {
        lib.moveCategory(id, target);
        parents.set(id, target);
      }
    }
    if (step % 10 === 9) {
      assertCountsMatch(lib, parents, [...articles.values()]);
    }
  }
  assertCountsMatch(lib, parents, [...articles.values()]);
  lib.close();
});

test("数据落盘后可重新打开读取", () => {
  const filename = `/tmp/content-lib-${process.pid}-${Date.now()}.sqlite`;
  const lib = new ContentLibrary({ filename });
  lib.addCategory("A", null);
  lib.addCategory("A1", "A");
  lib.upsertArticle({ id: "P", published: true, categoryIds: ["A1"] });
  lib.close();

  const reopened = new ContentLibrary({ filename });
  assert.equal(reopened.getCoverageCount("A"), 1);
  assert.equal(reopened.getCoverageCount("A1"), 1);
  reopened.close();
});
