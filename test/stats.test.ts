import assert from "node:assert/strict";
import { test } from "node:test";
import { CategoryStats } from "../src/index";
import { ArticleInput, PublishStatus } from "../src/types";

function newLib(): CategoryStats {
  return new CategoryStats({ dbPath: ":memory:" });
}

/** 标准答案：基于当前分类树与文章状态逐篇重算 */
class ReferenceModel {
  categories = new Map<string, { name: string; parentId: string | null }>();
  articles = new Map<string, { status: PublishStatus; categoryIds: Set<string> }>();

  createCategory(id: string, name: string, parentId: string | null): void {
    this.categories.set(id, { name, parentId });
  }

  upsertArticle(article: ArticleInput): void {
    this.articles.set(article.id, {
      status: article.status,
      categoryIds: new Set(article.categoryIds),
    });
  }

  moveCategory(categoryId: string, newParentId: string | null): void {
    const c = this.categories.get(categoryId);
    assert.ok(c, `model category ${categoryId} missing`);
    c.parentId = newParentId;
  }

  subtreeIds(rootId: string): Set<string> {
    const result = new Set<string>([rootId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [id, c] of this.categories) {
        if (!result.has(id) && c.parentId !== null && result.has(c.parentId)) {
          result.add(id);
          grew = true;
        }
      }
    }
    return result;
  }

  coverageCount(rootId: string): number {
    const scope = this.subtreeIds(rootId);
    let count = 0;
    for (const article of this.articles.values()) {
      if (article.status !== "published") continue;
      for (const categoryId of article.categoryIds) {
        if (scope.has(categoryId)) {
          count += 1;
          break;
        }
      }
    }
    return count;
  }

  depthOf(categoryId: string): number {
    let depth = 1;
    let cur = this.categories.get(categoryId);
    while (cur && cur.parentId !== null) {
      depth += 1;
      cur = this.categories.get(cur.parentId);
    }
    return depth;
  }

  subtreeHeight(categoryId: string): number {
    const scope = this.subtreeIds(categoryId);
    let max = 0;
    for (const id of scope) {
      max = Math.max(max, this.depthOf(id) - this.depthOf(categoryId) + 1);
    }
    return max;
  }
}

function assertAllCountsMatch(lib: CategoryStats, model: ReferenceModel): void {
  for (const id of model.categories.keys()) {
    assert.equal(
      lib.getCoverageCount(id),
      model.coverageCount(id),
      `分类 ${id} 覆盖计数不一致`
    );
  }
}

test("基本统计：仅已发布、命中多个后代只计一次、无归属不计入", () => {
  const lib = newLib();
  const root = lib.createCategory("root", null);
  const childA = lib.createCategory("childA", root);
  const childB = lib.createCategory("childB", root);
  const grand = lib.createCategory("grand", childA);

  lib.upsertArticle({ id: "a1", status: "published", categoryIds: [grand, childB] });
  lib.upsertArticle({ id: "a2", status: "published", categoryIds: [childA, childB] });
  lib.upsertArticle({ id: "a3", status: "unpublished", categoryIds: [grand] });
  lib.upsertArticle({ id: "a4", status: "published", categoryIds: [] });

  assert.equal(lib.getCoverageCount(root), 2);
  assert.equal(lib.getCoverageCount(childA), 2);
  assert.equal(lib.getCoverageCount(childB), 2);
  assert.equal(lib.getCoverageCount(grand), 1);
  lib.close();
});

test("重复提交相同内容不改变计数", () => {
  const lib = newLib();
  const root = lib.createCategory("root", null);
  const article: ArticleInput = { id: "a1", status: "published", categoryIds: [root] };
  lib.upsertArticle(article);
  lib.upsertArticle(article);
  lib.upsertArticle({ ...article });
  assert.equal(lib.getCoverageCount(root), 1);
  lib.upsertArticle({ id: "a1", status: "unpublished", categoryIds: [root] });
  lib.upsertArticle({ id: "a1", status: "unpublished", categoryIds: [root] });
  assert.equal(lib.getCoverageCount(root), 0);
  lib.close();
});

test("迁移三分支归属场景：不漏计旧祖先、不重计新祖先、子树内部不变", () => {
  const lib = newLib();
  // 旧祖先：otherOld 分支 + 待迁移子树 sub
  const oldRoot = lib.createCategory("oldRoot", null);
  const otherOld = lib.createCategory("otherOld", oldRoot);
  const sub = lib.createCategory("sub", oldRoot);
  const subChild = lib.createCategory("subChild", sub);
  // 新祖先：otherNew 分支
  const newRoot = lib.createCategory("newRoot", null);
  const otherNew = lib.createCategory("otherNew", newRoot);

  // X 同时归属：迁移子树内 + 旧祖先其他分支 + 新祖先其他分支
  lib.upsertArticle({
    id: "X",
    status: "published",
    categoryIds: [subChild, otherOld, otherNew],
  });
  // Y 仅在迁移子树内
  lib.upsertArticle({ id: "Y", status: "published", categoryIds: [subChild] });

  const before = {
    oldRoot: lib.getCoverageCount(oldRoot),
    newRoot: lib.getCoverageCount(newRoot),
    sub: lib.getCoverageCount(sub),
    subChild: lib.getCoverageCount(subChild),
    otherOld: lib.getCoverageCount(otherOld),
    otherNew: lib.getCoverageCount(otherNew),
  };
  assert.deepEqual(before, {
    oldRoot: 2, // X + Y，X 命中 subChild 与 otherOld 只计一次
    newRoot: 1, // X
    sub: 2,
    subChild: 2,
    otherOld: 1,
    otherNew: 1,
  });

  lib.moveCategory(sub, newRoot);

  // X 仍通过 otherOld 命中旧祖先：不能漏计
  assert.equal(lib.getCoverageCount(oldRoot), 1);
  // X 此前已通过 otherNew 命中新祖先：迁移后不能重复计入
  assert.equal(lib.getCoverageCount(newRoot), 2); // X + Y，各一次
  // 子树内部计数不因迁移位置改变
  assert.equal(lib.getCoverageCount(sub), 2);
  assert.equal(lib.getCoverageCount(subChild), 2);
  assert.equal(lib.getCoverageCount(otherOld), 1);
  assert.equal(lib.getCoverageCount(otherNew), 1);

  // 迁移后替换 X 的归属：去掉 otherOld，旧祖先应不再计入 X
  lib.upsertArticle({ id: "X", status: "published", categoryIds: [subChild, otherNew] });
  assert.equal(lib.getCoverageCount(oldRoot), 0);
  assert.equal(lib.getCoverageCount(newRoot), 2);
  lib.close();
});

test("迁移到顶层与层级上限校验", () => {
  const lib = newLib();
  const l1 = lib.createCategory("l1", null);
  const l2 = lib.createCategory("l2", l1);
  const l3 = lib.createCategory("l3", l2);
  const l4 = lib.createCategory("l4", l3);
  assert.throws(() => lib.createCategory("l5", l4), /超过/);

  lib.upsertArticle({ id: "a1", status: "published", categoryIds: [l4] });
  // l2 子树高 3，移到顶层后仍为 3 层，合法
  lib.moveCategory(l2, null);
  assert.equal(lib.getCoverageCount(l2), 1);
  assert.equal(lib.getCoverageCount(l1), 0);
  // l2(1) -> l3(2) -> l4(3)，再挂到 l1 下会变成 4 层，合法
  lib.moveCategory(l2, l1);
  assert.equal(lib.getCoverageCount(l1), 1);
  // 再把 l2 子树（高 3）挂到 l3 下会超过 4 层，非法（且成环，调用方保证不发生，这里仅验证深度校验）
  const l1b = lib.createCategory("l1b", null);
  const l2b = lib.createCategory("l2b", l1b);
  assert.throws(() => lib.moveCategory(l2, l2b), /超过/);
  lib.close();
});

test("输入校验：超过 8 个直接归属、分类不存在、非法状态", () => {
  const lib = newLib();
  const ids: string[] = [];
  for (let i = 0; i < 9; i += 1) ids.push(lib.createCategory(`c${i}`, null));
  assert.throws(
    () => lib.upsertArticle({ id: "a1", status: "published", categoryIds: ids }),
    /超过/
  );
  assert.throws(
    () => lib.upsertArticle({ id: "a1", status: "published", categoryIds: ["nope"] }),
    /不存在/
  );
  assert.throws(
    () =>
      lib.upsertArticle({
        id: "a1",
        status: "bad" as PublishStatus,
        categoryIds: [],
      }),
    /非法/
  );
  assert.throws(() => lib.getCoverageCount("nope"), /不存在/);
  assert.throws(() => lib.moveCategory("nope", null), /不存在/);
  lib.close();
});

test("连续迁移与归属替换、状态切换混合：最终与逐篇重算一致", () => {
  // 确定性伪随机，保证可复现
  function mulberry32(seed: number): () => number {
    let t = seed >>> 0;
    return () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(20261007);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)] as T;

  const lib = newLib();
  const model = new ReferenceModel();
  const categoryIds: string[] = [];
  const articleIds: string[] = [];
  let nameSeq = 0;
  let articleSeq = 0;

  const randomCategoryId = (): string => pick(categoryIds);
  const randomParentForNew = (): string | null => {
    const candidates = categoryIds.filter((id) => model.depthOf(id) < 4);
    if (candidates.length === 0 || rand() < 0.3) return null;
    return pick(candidates);
  };
  const validMoveTargets = (categoryId: string): (string | null)[] => {
    const subtree = model.subtreeIds(categoryId);
    const height = model.subtreeHeight(categoryId);
    const targets: (string | null)[] = [null];
    for (const id of categoryIds) {
      if (subtree.has(id)) continue; // 不成环
      if (model.depthOf(id) + height <= 4) targets.push(id);
    }
    return targets;
  };

  for (let step = 0; step < 300; step += 1) {
    const roll = rand();
    if (roll < 0.25 || categoryIds.length === 0) {
      const parentId = randomParentForNew();
      const id = lib.createCategory(`cat-${nameSeq}`, parentId);
      model.createCategory(id, `cat-${nameSeq}`, parentId);
      nameSeq += 1;
      categoryIds.push(id);
    } else if (roll < 0.65) {
      const id =
        articleIds.length > 0 && rand() < 0.6
          ? pick(articleIds)
          : `art-${articleSeq++}`;
      if (!articleIds.includes(id)) articleIds.push(id);
      const status: PublishStatus = rand() < 0.75 ? "published" : "unpublished";
      const k = Math.min(Math.floor(rand() * 9), categoryIds.length); // 0~8 个直接归属
      const chosen = new Set<string>();
      while (chosen.size < k) chosen.add(randomCategoryId());
      const input: ArticleInput = { id, status, categoryIds: [...chosen] };
      lib.upsertArticle(input);
      model.upsertArticle(input);
    } else {
      const categoryId = randomCategoryId();
      const targets = validMoveTargets(categoryId);
      const target = pick(targets);
      lib.moveCategory(categoryId, target);
      model.moveCategory(categoryId, target);
    }
    // 每 25 步全量比对一次，保证中间状态也始终一致
    if (step % 25 === 0) assertAllCountsMatch(lib, model);
  }
  assertAllCountsMatch(lib, model);
  assert.ok(categoryIds.length > 10, "场景应产生足够多的分类");
  assert.ok(articleIds.length > 10, "场景应产生足够多的文章");
  lib.close();
});

test("文件持久化：关闭后重开数据仍在", () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "catstats-")),
    "data.db"
  );
  const lib = new CategoryStats({ dbPath });
  const root = lib.createCategory("root", null);
  lib.upsertArticle({ id: "a1", status: "published", categoryIds: [root] });
  lib.close();

  const lib2 = new CategoryStats({ dbPath });
  assert.equal(lib2.getCoverageCount(root), 1);
  lib2.close();
});
