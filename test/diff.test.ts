import assert from "node:assert/strict";
import { test } from "node:test";
import { diffLines, splitLines } from "../src/index";

test("splitLines: empty text has zero lines", () => {
  assert.deepEqual(splitLines(""), []);
});

test("splitLines: LF belongs to the preceding line", () => {
  assert.deepEqual(splitLines("a\nb\nc"), ["a\n", "b\n", "c"]);
});

test("splitLines: trailing LF does not add an empty line", () => {
  assert.deepEqual(splitLines("a\n"), ["a\n"]);
  assert.deepEqual(splitLines("\n"), ["\n"]);
  assert.deepEqual(splitLines("a\n\n"), ["a\n", "\n"]);
});

test("splitLines: last line may lack LF and is kept verbatim", () => {
  assert.deepEqual(splitLines("a\nb "), ["a\n", "b "]);
});

test("diffLines: no changes for identical input", () => {
  assert.deepEqual(diffLines(["a\n", "b\n"], ["a\n", "b\n"]), []);
});

test("diffLines: replacement is one change", () => {
  assert.deepEqual(diffLines(["a\n", "b\n"], ["a\n", "c\n"]), [
    { start: 1, deleteCount: 1, inserted: ["c\n"] },
  ]);
});

test("diffLines: pure insertion is located between ancestor lines", () => {
  assert.deepEqual(diffLines(["a\n", "b\n"], ["a\n", "x\n", "b\n"]), [
    { start: 1, deleteCount: 0, inserted: ["x\n"] },
  ]);
});

test("diffLines: consecutive deletes and inserts merge into one change", () => {
  assert.deepEqual(
    diffLines(["a\n", "b\n", "c\n"], ["a\n", "x\n", "y\n"]),
    [{ start: 1, deleteCount: 2, inserted: ["x\n", "y\n"] }],
  );
});

test("diffLines: kept lines separate changes", () => {
  assert.deepEqual(
    diffLines(["a\n", "b\n", "c\n"], ["x\n", "b\n", "y\n"]),
    [
      { start: 0, deleteCount: 1, inserted: ["x\n"] },
      { start: 2, deleteCount: 1, inserted: ["y\n"] },
    ],
  );
});

test("diffLines: minimal edits with keep/delete/insert tie-break order", () => {
  // Both "delete a, keep b, insert a" and "insert b, keep a, delete b"
  // are minimal (2 edits); the keep/delete/insert priority picks the
  // lexicographically smallest operation sequence: delete, keep, insert.
  assert.deepEqual(diffLines(["a\n", "b\n"], ["b\n", "a\n"]), [
    { start: 0, deleteCount: 1, inserted: [] },
    { start: 2, deleteCount: 0, inserted: ["a\n"] },
  ]);
});

test("diffLines: lines are compared byte-exactly, no normalization", () => {
  assert.deepEqual(diffLines(["a"], ["a\n"]), [
    { start: 0, deleteCount: 1, inserted: ["a\n"] },
  ]);
  assert.deepEqual(diffLines(["a \n"], ["a\n"]), [
    { start: 0, deleteCount: 1, inserted: ["a\n"] },
  ]);
});
