import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SensitiveWordStore, type MatchHit } from "../src/index.js";

function tempDb(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "sensitive-words-")),
    "words.db",
  );
}

function withStore(
  entries: Array<{ id: number; text: string }>,
  fn: (store: SensitiveWordStore) => void,
): void {
  const dbPath = tempDb();
  const store = new SensitiveWordStore(dbPath);
  try {
    store.replaceWords(entries);
    fn(store);
  } finally {
    store.close();
  }
}

test("兼容连字：词条 f 和 fi 都高亮完整的 ﬃ，f 只报告一次", () => {
  withStore(
    [
      { id: 1, text: "f" },
      { id: 2, text: "fi" },
    ],
    (store) => {
      const hits = store.check("😀xﬃy");
      assert.deepEqual(hits, [
        { id: 1, start: 3, end: 4 },
        { id: 2, start: 3, end: 4 },
      ]);
    },
  );
});

test("组合音标 + 隐形字符：é 命中 e、U+200B、U+0301，覆盖全部 3 个代码单元", () => {
  withStore([{ id: 7, text: "é" }], (store) => {
    const hits = store.check("e​́");
    assert.deepEqual(hits, [{ id: 7, start: 0, end: 3 }]);
  });
});

test("全量替换词表后重新打开库仍可使用", () => {
  const dbPath = tempDb();
  const first = new SensitiveWordStore(dbPath);
  first.replaceWords([{ id: 1, text: "old" }]);
  first.close();

  const second = new SensitiveWordStore(dbPath);
  assert.deepEqual(second.check("say old"), [{ id: 1, start: 4, end: 7 }]);

  second.replaceWords([
    { id: 2, text: "new" },
    { id: 3, text: "fresh" },
  ]);
  second.close();

  const third = new SensitiveWordStore(dbPath);
  try {
    assert.deepEqual(third.check("say old"), []);
    assert.deepEqual(third.check("a new fresh day"), [
      { id: 2, start: 2, end: 5 },
      { id: 3, start: 6, end: 11 },
    ]);
  } finally {
    third.close();
  }
});

test("返回全部命中，包括相互重叠的命中", () => {
  withStore(
    [
      { id: 1, text: "aba" },
      { id: 2, text: "bab" },
      { id: 3, text: "ab" },
    ],
    (store) => {
      const hits = store.check("abab");
      assert.deepEqual(hits, [
        { id: 3, start: 0, end: 2 },
        { id: 1, start: 0, end: 3 },
        { id: 2, start: 1, end: 4 },
        { id: 3, start: 2, end: 4 },
      ]);
    },
  );
});

test("不同编号的词条标准化后相同也分别报告", () => {
  withStore(
    [
      { id: 1, text: "hello" },
      { id: 2, text: "HELLO" },
      { id: 3, text: "ｈｅｌｌｏ" },
    ],
    (store) => {
      const hits = store.check("say Hello");
      assert.deepEqual(hits, [
        { id: 1, start: 4, end: 9 },
        { id: 2, start: 4, end: 9 },
        { id: 3, start: 4, end: 9 },
      ]);
    },
  );
});

test("标准化后为空的词条不产生命中", () => {
  withStore(
    [
      { id: 1, text: "​⁠﻿" },
      { id: 2, text: "" },
      { id: 3, text: "a" },
    ],
    (store) => {
      const hits = store.check("a​b");
      assert.deepEqual(hits, [{ id: 3, start: 0, end: 1 }]);
    },
  );
});

test("忽略 U+200B / U+2060 / U+FEFF，但不忽略空白和标点", () => {
  withStore(
    [
      { id: 1, text: "ab" },
      { id: 2, text: "a b" },
    ],
    (store) => {
      // 隐形字符穿插不影响命中
      assert.deepEqual(store.check("a​b"), [{ id: 1, start: 0, end: 3 }]);
      assert.deepEqual(store.check("a⁠b"), [{ id: 1, start: 0, end: 3 }]);
      assert.deepEqual(store.check("a﻿b"), [{ id: 1, start: 0, end: 3 }]);
      // 空白不被忽略："ab" 不命中 "a b"，"a b" 命中 "a b"
      assert.deepEqual(store.check("a b"), [{ id: 2, start: 0, end: 3 }]);
    },
  );
});

test("A-Z 视同 a-z，全角字符按 NFKC 归一", () => {
  withStore(
    [
      { id: 1, text: "Word" },
      { id: 2, text: "ＡＢＣ" },
    ],
    (store) => {
      assert.deepEqual(store.check("a wOrD z"), [{ id: 1, start: 2, end: 6 }]);
      assert.deepEqual(store.check("xaBcY"), [{ id: 2, start: 1, end: 4 }]);
    },
  );
});

test("跨字符命中的区间包含内部隐形字符，但不吸收首尾之外的隐形字符", () => {
  withStore([{ id: 1, text: "ab" }], (store) => {
    // 命中 a…b，中间的 U+200B 被区间覆盖；首尾之外的 U+200B 不进入区间
    const hits = store.check("​a​b​");
    assert.deepEqual(hits, [{ id: 1, start: 1, end: 4 }]);
  });
});

test("兼容字符展开后命中一部分也高亮完整原始字符", () => {
  // "ﬂ" NFKC 展开为 "fl"，词条 "l" 只占展开结果一部分，仍高亮整个 ﬂ
  withStore([{ id: 1, text: "l" }], (store) => {
    const hits = store.check("aﬂb");
    assert.deepEqual(hits, [{ id: 1, start: 1, end: 2 }]);
  });
});

test("同一词条同一原文区间的多次命中只报告一次", () => {
  withStore([{ id: 1, text: "i" }], (store) => {
    // ﬃ 展开为 ffi，含两个 i，但只报告一次
    const hits = store.check("ﬃ");
    assert.deepEqual(hits, [{ id: 1, start: 0, end: 1 }]);
  });
});

test("词条中的隐形字符同样被忽略（词条与评价同一匹配语义）", () => {
  withStore([{ id: 1, text: "a​b" }], (store) => {
    assert.deepEqual(store.check("ab"), [{ id: 1, start: 0, end: 2 }]);
  });
});

test("命中区间按 UTF-16 代码单元计数（代理对）", () => {
  withStore([{ id: 1, text: "b" }], (store) => {
    // 😀 占 2 个 UTF-16 单元
    assert.deepEqual(store.check("😀b"), [{ id: 1, start: 2, end: 3 }]);
  });
});
