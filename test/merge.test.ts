import test from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { previewMerge, resolveMerge } from "../src/merge";
import type { MergePreview } from "../src";

/** 无冲突时直接得到最终文本。 */
function autoMerged(preview: MergePreview): string {
  equal(preview.conflicts.length, 0, "expected no conflicts");
  return resolveMerge(preview, []);
}

test("互不影响的相接替换自动合并", () => {
  // ours 改第 2 行，theirs 改第 3 行，区间 [1,2) 与 [2,3) 首尾相接不算冲突。
  const preview = previewMerge("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nC\nd\n");
  equal(autoMerged(preview), "a\nB\nC\nd\n");
});

test("起点插入排在替换文本前", () => {
  // ours 在第 1 行间位置插入 X，theirs 把第 1 行 b 替换为 B。
  // 插入恰在对方区间起点，不互相影响，且插入文本排在替换文本前。
  const preview = previewMerge("a\nb\nc\n", "a\nX\nb\nc\n", "a\nB\nc\n");
  equal(autoMerged(preview), "a\nX\nB\nc\n");
});

test("终点插入排在替换文本后", () => {
  // ours 在第 2 行间位置插入 X，theirs 把第 1 行 b 替换为 B。
  const preview = previewMerge("a\nb\nc\n", "a\nb\nX\nc\n", "a\nB\nc\n");
  equal(autoMerged(preview), "a\nB\nX\nc\n");
});

test("重叠链经传递关系形成一个冲突，两侧未改行保留", () => {
  // ours 改 [1,3) 与 [4,6)，theirs 改 [2,5)；ours 的两处改动不直接
  // 互相影响，但都碰上 theirs 的改动，经传递归为同一区域 [1,6)。
  const preview = previewMerge(
    "0\n1\n2\n3\n4\n5\n6\n",
    "0\na\n3\nb\n6\n",
    "0\n1\nx\n5\n6\n",
  );
  equal(preview.conflicts.length, 1);
  const conflict = preview.conflicts[0]!;
  equal(conflict.ancestor, "1\n2\n3\n4\n5\n");
  equal(conflict.ours, "a\n3\nb\n");
  equal(conflict.theirs, "1\nx\n5\n");
  // 区域外的祖先行原样保留在自动段中。
  deepEqual(preview.segments, [
    { kind: "auto", text: "0\n" },
    conflict,
    { kind: "auto", text: "6\n" },
  ]);
  equal(resolveMerge(preview, [{ side: "ours" }]), "0\na\n3\nb\n6\n");
  equal(resolveMerge(preview, [{ side: "theirs" }]), "0\n1\nx\n5\n6\n");
});

test("重叠冲突区域外的未改行保留", () => {
  const preview = previewMerge(
    "0\n1\n2\n3\n4\n5\n6\n",
    "0\n1\ntwo\nthree\n4\n5\n6\n",
    "0\n1\n2\ndrei\nvier\n5\n6\n",
  );
  equal(preview.conflicts.length, 1);
  const conflict = preview.conflicts[0]!;
  equal(conflict.ancestor, "2\n3\n4\n");
  equal(conflict.ours, "two\nthree\n4\n");
  equal(conflict.theirs, "2\ndrei\nvier\n");
  deepEqual(preview.segments, [
    { kind: "auto", text: "0\n1\n" },
    conflict,
    { kind: "auto", text: "5\n6\n" },
  ]);
  equal(resolveMerge(preview, [{ side: "ours" }]), "0\n1\ntwo\nthree\n4\n5\n6\n");
  equal(resolveMerge(preview, [{ side: "theirs" }]), "0\n1\n2\ndrei\nvier\n5\n6\n");
});

test("两侧同一位置的纯插入互相影响", () => {
  const preview = previewMerge("a\nb\n", "a\nX\nb\n", "a\nY\nb\n");
  equal(preview.conflicts.length, 1);
  const conflict = preview.conflicts[0]!;
  equal(conflict.ancestor, "");
  equal(conflict.ours, "X\n");
  equal(conflict.theirs, "Y\n");
  equal(resolveMerge(preview, [{ side: "theirs" }]), "a\nY\nb\n");
});

test("两侧插入相同文本只保留一份", () => {
  const preview = previewMerge("a\nb\n", "a\nX\nb\n", "a\nX\nb\n");
  equal(autoMerged(preview), "a\nX\nb\n");
});

test("两侧做出相同改动只保留一份", () => {
  const preview = previewMerge("a\nb\n", "A\nb\n", "A\nb\n");
  equal(autoMerged(preview), "A\nb\n");
});

test("纯插入严格落在对方区间内部才互相影响", () => {
  const inside = previewMerge("a\nb\nc\n", "z\n", "a\nX\nb\nc\n");
  equal(inside.conflicts.length, 1);
  equal(inside.conflicts[0]!.ancestor, "a\nb\nc\n");
  equal(inside.conflicts[0]!.ours, "z\n");
  equal(inside.conflicts[0]!.theirs, "a\nX\nb\nc\n");
});

test("纯插入恰在对方区间起点或终点不互相影响", () => {
  // ours 把 [1,3) 替换为 z，theirs 在位置 1（起点）插入 X。
  const atStart = previewMerge("a\nb\nc\nd\n", "a\nz\nd\n", "a\nX\nb\nc\nd\n");
  equal(autoMerged(atStart), "a\nX\nz\nd\n");
  // theirs 在位置 3（终点）插入 X。
  const atEnd = previewMerge("a\nb\nc\nd\n", "a\nz\nd\n", "a\nb\nc\nX\nd\n");
  equal(autoMerged(atEnd), "a\nz\nX\nd\n");
});

test("人工可以提供替换文本", () => {
  const preview = previewMerge("a\nb\n", "a\nX\n", "a\nY\n");
  equal(preview.conflicts.length, 1);
  // 替换文本只覆盖冲突区域（第 2 行），区域外的自动内容不受影响。
  equal(resolveMerge(preview, [{ side: "custom", text: "manual\n" }]), "a\nmanual\n");
});

test("全部冲突解决后才有最终文本", () => {
  const preview = previewMerge("a\nb\n", "a\nX\n", "a\nY\n");
  throws(() => resolveMerge(preview, []));
});

test("解决选择不覆盖冲突之外的自动合并内容", () => {
  // 第 1 行冲突，第 3 行两侧各自自动合并；custom 文本不得影响后者。
  const preview = previewMerge(
    "a\nb\nc\nd\n",
    "A\nb\nC1\nd\n",
    "A2\nb\nC2\nd\n",
  );
  // 第 1 行：A 与 A2 冲突；第 3 行：C1 与 C2 冲突。两处互不相邻，各成一个冲突。
  equal(preview.conflicts.length, 2);
  const final = resolveMerge(preview, [
    { side: "custom", text: "chosen\n" },
    { side: "ours" },
  ]);
  equal(final, "chosen\nb\nC1\nd\n");
  equal(final.includes("<<<<<<<"), false);
  equal(final.includes(">>>>>>>"), false);
});

test("不向正文写入冲突标记", () => {
  const preview = previewMerge("a\n", "b\n", "c\n");
  const final = resolveMerge(preview, [{ side: "ours" }]);
  equal(final, "b\n");
});

test("三个空文本合并为空", () => {
  const preview = previewMerge("", "", "");
  deepEqual(preview.segments, []);
  equal(autoMerged(preview), "");
});

test("一侧未改动时保留另一侧", () => {
  const preview = previewMerge("a\nb\n", "a\nb\n", "a\nB\n");
  equal(autoMerged(preview), "a\nB\n");
});

test("末行无 LF 的版本原样保留", () => {
  const preview = previewMerge("a\nb", "a\nc", "a\nb");
  equal(autoMerged(preview), "a\nc");
});

test("末尾是否带 LF 是有效改动且能合并", () => {
  // ours 给末行补上 LF，theirs 改第一行，互不干扰。
  const preview = previewMerge("a\nb", "a\nb\n", "A\nb");
  equal(autoMerged(preview), "A\nb\n");
});
