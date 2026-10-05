"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const index_js_1 = require("../src/index.js");
function withDb(fn) {
    const dir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), "sensitive-word-review-"));
    try {
        return fn((0, node_path_1.join)(dir, "words.db"));
    }
    finally {
        (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
    }
}
function sorted(hits) {
    return [...hits].sort((a, b) => a.entryId - b.entryId || a.start - b.start || a.end - b.end);
}
(0, node_test_1.test)("兼容连字：词条 f 和 fi 都高亮完整的 ﬃ（区间 3-4），f 只报告一次", () => {
    withDb((dbPath) => {
        const review = new index_js_1.SensitiveWordReview(dbPath);
        review.replaceEntries([
            { id: 1, text: "f" },
            { id: 2, text: "fi" },
        ]);
        // "😀xﬃy"：😀 占 2 个 UTF-16 代码单元，x 在 2，ﬃ 在 3，y 在 4
        const hits = review.check("😀xﬃy");
        strict_1.default.deepEqual(sorted(hits), [
            { entryId: 1, start: 3, end: 4 },
            { entryId: 2, start: 3, end: 4 },
        ]);
        review.close();
    });
});
(0, node_test_1.test)("组合音标 + 隐形字符：词条 é 命中 e、U+200B、U+0301，覆盖全部 3 个代码单元", () => {
    withDb((dbPath) => {
        const review = new index_js_1.SensitiveWordReview(dbPath);
        review.replaceEntries([{ id: 7, text: "é" }]);
        const hits = review.check("e​́");
        strict_1.default.deepEqual(hits, [{ entryId: 7, start: 0, end: 3 }]);
        review.close();
    });
});
(0, node_test_1.test)("词表全量替换后在重新打开库时仍可使用", () => {
    withDb((dbPath) => {
        const first = new index_js_1.SensitiveWordReview(dbPath);
        first.replaceEntries([
            { id: 1, text: "苹果" },
            { id: 2, text: "banana" },
        ]);
        first.close();
        const second = new index_js_1.SensitiveWordReview(dbPath);
        strict_1.default.deepEqual(second.listEntries(), [
            { id: 1, text: "苹果" },
            { id: 2, text: "banana" },
        ]);
        strict_1.default.deepEqual(second.check("吃了一个苹果"), [{ entryId: 1, start: 4, end: 6 }]);
        // 再次全量替换，旧词失效、新词生效
        second.replaceEntries([{ id: 3, text: "橘子" }]);
        second.close();
        const third = new index_js_1.SensitiveWordReview(dbPath);
        strict_1.default.deepEqual(third.listEntries(), [{ id: 3, text: "橘子" }]);
        strict_1.default.deepEqual(third.check("吃了一个苹果"), []);
        strict_1.default.deepEqual(third.check("橘子熟了"), [{ entryId: 3, start: 0, end: 2 }]);
        third.close();
    });
});
(0, node_test_1.test)("重叠命中与重复出现全部返回", () => {
    withDb((dbPath) => {
        const review = new index_js_1.SensitiveWordReview(dbPath);
        review.replaceEntries([
            { id: 1, text: "aa" },
            { id: 2, text: "aaa" },
        ]);
        const hits = review.check("aaaa");
        strict_1.default.deepEqual(sorted(hits), [
            { entryId: 1, start: 0, end: 2 },
            { entryId: 1, start: 1, end: 3 },
            { entryId: 1, start: 2, end: 4 },
            { entryId: 2, start: 0, end: 3 },
            { entryId: 2, start: 1, end: 4 },
        ]);
        review.close();
    });
});
(0, node_test_1.test)("不同编号词条标准化后相同也分别报告；标准化为空的词条不命中", () => {
    withDb((dbPath) => {
        const review = new index_js_1.SensitiveWordReview(dbPath);
        review.replaceEntries([
            { id: 1, text: "HF" },
            { id: 2, text: "ｈｆ" }, // 全角，NFKC 后同为 hf
            { id: 3, text: "​" }, // 只有隐形字符，标准化后为空
        ]);
        const hits = review.check("hf");
        strict_1.default.deepEqual(sorted(hits), [
            { entryId: 1, start: 0, end: 2 },
            { entryId: 2, start: 0, end: 2 },
        ]);
        review.close();
    });
});
(0, node_test_1.test)("全角字符与大小写：词条与评价使用同一匹配语义", () => {
    withDb((dbPath) => {
        const review = new index_js_1.SensitiveWordReview(dbPath);
        review.replaceEntries([{ id: 1, text: "ｈｅｌｌｏ" }]);
        const hits = review.check("say HeLLo!");
        strict_1.default.deepEqual(hits, [{ entryId: 1, start: 4, end: 9 }]);
        review.close();
    });
});
(0, node_test_1.test)("区间不吸收首尾之外的隐形字符，但包含内部的", () => {
    withDb((dbPath) => {
        const review = new index_js_1.SensitiveWordReview(dbPath);
        review.replaceEntries([{ id: 1, text: "ab" }]);
        // 首尾各一个 U+200B，中间 a 与 b 之间一个 U+FEFF
        const hits = review.check("​a﻿b​");
        strict_1.default.deepEqual(hits, [{ entryId: 1, start: 1, end: 4 }]);
        review.close();
    });
});
(0, node_test_1.test)("兼容字符展开后部分命中也高亮完整原始字符", () => {
    withDb((dbPath) => {
        const review = new index_js_1.SensitiveWordReview(dbPath);
        // ﬃ(U+FB03) NFKC 展开为 ffi，词条 fi 只占展开结果的后两个字符，仍高亮整个 ﬃ
        review.replaceEntries([{ id: 1, text: "fi" }]);
        const hits = review.check("aﬃb");
        strict_1.default.deepEqual(hits, [{ entryId: 1, start: 1, end: 2 }]);
        review.close();
    });
});
(0, node_test_1.test)("同一词条在同一原文区间的多次命中只报告一次", () => {
    withDb((dbPath) => {
        const review = new index_js_1.SensitiveWordReview(dbPath);
        review.replaceEntries([{ id: 1, text: "f" }]);
        const hits = review.check("ﬃ"); // 展开为 fff，3 次命中落在同一区间
        strict_1.default.deepEqual(hits, [{ entryId: 1, start: 0, end: 1 }]);
        review.close();
    });
});
(0, node_test_1.test)("空评价与空词表", () => {
    withDb((dbPath) => {
        const review = new index_js_1.SensitiveWordReview(dbPath);
        strict_1.default.deepEqual(review.check("任意文本"), []);
        review.replaceEntries([{ id: 1, text: "词" }]);
        strict_1.default.deepEqual(review.check(""), []);
        review.close();
    });
});
