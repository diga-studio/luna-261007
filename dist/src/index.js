"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SensitiveWordReview = exports.normalizeText = void 0;
const normalize_js_1 = require("./normalize.js");
const matcher_js_1 = require("./matcher.js");
const store_js_1 = require("./store.js");
var normalize_js_2 = require("./normalize.js");
Object.defineProperty(exports, "normalizeText", { enumerable: true, get: function () { return normalize_js_2.normalizeText; } });
/** 敏感词审核库入口：由评价收集和人工审核模块直接调用 */
class SensitiveWordReview {
    store;
    constructor(dbPath) {
        this.store = new store_js_1.WordStore(dbPath);
    }
    /** 全量替换词表；提交成功后重新打开库仍可使用 */
    replaceEntries(entries) {
        this.store.replaceAll(entries);
    }
    /** 读取当前词表 */
    listEntries() {
        return this.store.getAll();
    }
    /** 检查一条评价，返回全部命中（含重叠），区间为原文 UTF-16 代码单元 [start, end) */
    check(text) {
        const entries = this.store
            .getAll()
            .map((entry) => ({ id: entry.id, normalized: (0, normalize_js_1.normalizeText)(entry.text) }));
        return (0, matcher_js_1.findHits)((0, normalize_js_1.normalizeWithMap)(text), entries);
    }
    close() {
        this.store.close();
    }
}
exports.SensitiveWordReview = SensitiveWordReview;
