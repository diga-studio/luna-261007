import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePreview, resolveMerge } from "../src/index";
import type { ConflictSegment } from "../src/index";

function onlyConflict(preview: {
  conflicts: ConflictSegment[];
}): ConflictSegment {
  assert.equal(preview.conflicts.length, 1);
  return preview.conflicts[0];
}

test("clean merge: identical inputs yield a single auto segment", () => {
  const preview = mergePreview("a\nb\n", "a\nb\n", "a\nb\n");
  assert.deepEqual(preview.conflicts, []);
  assert.deepEqual(preview.segments, [{ kind: "auto", text: "a\nb\n" }]);
  assert.equal(resolveMerge(preview, []), "a\nb\n");
});

test("empty texts merge to empty result", () => {
  const preview = mergePreview("", "", "");
  assert.deepEqual(preview.segments, []);
  assert.equal(resolveMerge(preview, []), "");
});

test("adjacent replacements and endpoint insertions auto-merge", () => {
  // current replaces line b ([1,2)) and inserts x at position 3, which is
  // exactly the end of incoming's replacement of line c ([2,3)). Touching
  // intervals and endpoint insertions do not interact.
  const ancestor = "a\nb\nc\nd\ne\n";
  const current = "a\nB\nc\nx\nd\ne\n";
  const incoming = "a\nb\nC\nd\ne\n";
  const preview = mergePreview(ancestor, current, incoming);
  assert.deepEqual(preview.conflicts, []);
  assert.equal(resolveMerge(preview, []), "a\nB\nC\nx\nd\ne\n");
});

test("insertion at replacement start goes before the replacement text", () => {
  const ancestor = "a\nb\nc\n";
  const current = "a\nx\nB\nc\n"; // insert x at 1, replace b ([1,2))
  const incoming = "a\nb\nc\n";
  const preview = mergePreview(ancestor, current, incoming);
  assert.deepEqual(preview.conflicts, []);
  assert.equal(resolveMerge(preview, []), "a\nx\nB\nc\n");
});

test("overlap chain forms one conflict and keeps untouched lines", () => {
  // current: [1,3) -> a, [4,6) -> c; incoming: [2,5) -> b.
  // current's two changes do not overlap each other, but both overlap
  // incoming's change, so all three chain into a single region [1,6).
  const ancestor = "1\n2\n3\n4\n5\n6\n7\n";
  const current = "1\na\n4\nc\n7\n";
  const incoming = "1\n2\nb\n6\n7\n";
  const preview = mergePreview(ancestor, current, incoming);

  const conflict = onlyConflict(preview);
  assert.equal(conflict.ancestor, "2\n3\n4\n5\n6\n");
  assert.equal(conflict.current, "a\n4\nc\n");
  assert.equal(conflict.incoming, "2\nb\n6\n");

  assert.deepEqual(preview.segments, [
    { kind: "auto", text: "1\n" },
    conflict,
    { kind: "auto", text: "7\n" },
  ]);

  assert.equal(
    resolveMerge(preview, [{ id: 0, choice: "current" }]),
    "1\na\n4\nc\n7\n",
  );
  assert.equal(
    resolveMerge(preview, [{ id: 0, choice: "incoming" }]),
    "1\n2\nb\n6\n7\n",
  );
  assert.equal(
    resolveMerge(preview, [{ id: 0, choice: "replace", text: "z\n" }]),
    "1\nz\n7\n",
  );
});

test("pure insertions at the same position conflict with empty ancestor", () => {
  const preview = mergePreview("a\nb\n", "a\nx\nb\n", "a\ny\nb\n");
  const conflict = onlyConflict(preview);
  assert.equal(conflict.ancestor, "");
  assert.equal(conflict.current, "x\n");
  assert.equal(conflict.incoming, "y\n");
  assert.equal(
    resolveMerge(preview, [{ id: 0, choice: "replace", text: "z\n" }]),
    "a\nz\nb\n",
  );
});

test("identical changes on both sides merge to one copy", () => {
  const preview = mergePreview("a\nb\n", "a\nx\nb\n", "a\nx\nb\n");
  assert.deepEqual(preview.conflicts, []);
  assert.equal(resolveMerge(preview, []), "a\nx\nb\n");

  const replaced = mergePreview("a\nb\nc\n", "a\nQ\nc\n", "a\nQ\nc\n");
  assert.deepEqual(replaced.conflicts, []);
  assert.equal(resolveMerge(replaced, []), "a\nQ\nc\n");
});

test("insertion strictly inside the other side's interval conflicts", () => {
  const ancestor = "1\n2\n3\n4\n";
  const current = "1\nA\n4\n"; // replace [1,3)
  const incoming = "1\n2\nx\n3\n4\n"; // insert x at 2, strictly inside
  const preview = mergePreview(ancestor, current, incoming);
  const conflict = onlyConflict(preview);
  assert.equal(conflict.ancestor, "2\n3\n");
  assert.equal(conflict.current, "A\n");
  assert.equal(conflict.incoming, "2\nx\n3\n");
});

test("insertion at interval boundary does not interact", () => {
  const ancestor = "1\n2\n3\n4\n";
  const current = "1\nA\n4\n"; // replace [1,3)
  const atStart = mergePreview(ancestor, current, "x\n1\n2\n3\n4\n");
  assert.deepEqual(atStart.conflicts, []);
  assert.equal(resolveMerge(atStart, []), "x\n1\nA\n4\n");
  const atEnd = mergePreview(ancestor, current, "1\n2\n3\nx\n4\n");
  assert.deepEqual(atEnd.conflicts, []);
  assert.equal(resolveMerge(atEnd, []), "1\nA\nx\n4\n");
});

test("no trailing LF and no whitespace normalization anywhere", () => {
  const preview = mergePreview("a\nb", "a\nc", "a\nb ");
  const conflict = onlyConflict(preview);
  assert.equal(conflict.ancestor, "b");
  assert.equal(conflict.current, "c");
  assert.equal(conflict.incoming, "b ");
  assert.equal(
    resolveMerge(preview, [{ id: 0, choice: "incoming" }]),
    "a\nb ",
  );

  const clean = mergePreview("a\nb", "x\na\nb", "a\nb");
  assert.equal(resolveMerge(clean, []), "x\na\nb");
});

test("final text requires every conflict to be resolved exactly once", () => {
  const preview = mergePreview("a\nb\n", "a\nx\nb\n", "a\ny\nb\n");
  assert.throws(() => resolveMerge(preview, []), /unresolved conflict 0/);
  assert.throws(
    () => resolveMerge(preview, [{ id: 1, choice: "current" }]),
    /unknown conflict id: 1/,
  );
  assert.throws(
    () =>
      resolveMerge(preview, [
        { id: 0, choice: "current" },
        { id: 0, choice: "incoming" },
      ]),
    /duplicate resolution for conflict 0/,
  );
});

test("resolution never alters auto-merged content and adds no markers", () => {
  const ancestor = "h1\n1\n2\n3\nf1\n";
  const current = "h2\n1\nA\n3\nf1\n";
  const incoming = "h1\n1\nB\n3\nf2\n";
  const preview = mergePreview(ancestor, current, incoming);
  const conflict = onlyConflict(preview);
  const out = resolveMerge(preview, [
    { id: conflict.id, choice: "replace", text: "R\n" },
  ]);
  assert.equal(out, "h2\n1\nR\n3\nf2\n");
  assert.ok(!out.includes("<<<<<<<"));
  assert.ok(!out.includes("======="));
  assert.ok(!out.includes(">>>>>>>"));
});

test("multiple independent conflicts get sequential ids in document order", () => {
  const ancestor = "1\n2\n3\n4\n5\n";
  const current = "a\n2\n3\n4\nc\n";
  const incoming = "b\n2\n3\n4\nd\n";
  const preview = mergePreview(ancestor, current, incoming);
  assert.equal(preview.conflicts.length, 2);
  assert.deepEqual(
    preview.conflicts.map((c) => c.id),
    [0, 1],
  );
  assert.equal(preview.conflicts[0].current, "a\n");
  assert.equal(preview.conflicts[1].incoming, "d\n");
  assert.equal(
    resolveMerge(preview, [
      { id: 0, choice: "incoming" },
      { id: 1, choice: "current" },
    ]),
    "b\n2\n3\n4\nc\n",
  );
});
