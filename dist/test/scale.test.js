"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const engine_1 = require("../src/engine");
/**
 * 规模测试：10 万条候补，绝大多数因“监狱成员”永不释放而不可录取。
 * 之后反复进行只影响少量成员的撤回与新增，用引擎的诊断计数器证明：
 * 这些操作访问的候补条目数与 10 万无关（有常数上界），即没有全量扫描。
 */
(0, node_test_1.test)("10 万候补下局部撤回/新增不扫描无关条目", { timeout: 120_000 }, () => {
    const BLOCKED_COUNT = 100_000;
    const CHURN_OPS = 2_000;
    const engine = new engine_1.WaitlistEngine([
        { id: "JAIL", capacity: 20 },
        { id: "HOT", capacity: 1 },
    ], [["JAIL", "HOT"]]);
    // 监狱团队：20 名成员永久占用 JAIL，JAIL∼HOT 冲突使含这些成员的候补全部阻塞。
    const jailMembers = Array.from({ length: 20 }, (_, i) => `jail${i}`);
    engine.register("JAIL", jailMembers);
    // 10 万条候补：每条含 1 名监狱成员 + 1 名唯一成员，报在 HOT 上，全部不可录取。
    for (let i = 0; i < BLOCKED_COUNT; i++) {
        engine.register("HOT", [jailMembers[i % 20], `u${i}`]);
    }
    {
        const insp = engine.inspect();
        const waiting = insp.registrations.filter((r) => r.status === "waiting");
        strict_1.default.equal(waiting.length, BLOCKED_COUNT);
        strict_1.default.equal(insp.tracks.find((t) => t.id === "HOT").occupied, 0);
    }
    const statsBefore = engine.stats;
    // 局部搅动：每轮在 HOT 上新增 1 条候补，并撤回当前已录取者，
    // 释放的名额触发一次真实的容量窗口递补（新候补随即被录取）。
    // 成员全部唯一，与 10 万条阻塞候补无关。
    let admitted = engine.register("HOT", ["init"]); // HOT 空闲，立即录取
    for (let i = 0; i < CHURN_OPS; i++) {
        const next = engine.register("HOT", [`w${i}`]); // HOT 已满，进入候补
        engine.withdraw(admitted); // 撤回已录取报名，释放 1 个名额
        admitted = next; // 递补规则保证 next 被录取
    }
    const stats = engine.stats;
    const deltaVisited = stats.indexedEntriesVisited - statsBefore.indexedEntriesVisited;
    const deltaRechecks = stats.rechecks - statsBefore.rechecks;
    // 每次搅动只应访问常数个条目（容量窗口内桶 + 相关成员的阻塞候补）。
    // 放宽到每次 50 个仍远小于 10 万；且总量不到一次全量扫描的规模。
    strict_1.default.ok(deltaVisited <= 50 * CHURN_OPS, `indexedEntriesVisited grew too much: ${deltaVisited}`);
    strict_1.default.ok(deltaRechecks <= 50 * CHURN_OPS, `rechecks grew too much: ${deltaRechecks}`);
    strict_1.default.ok(deltaVisited < BLOCKED_COUNT, `visited ${deltaVisited} entries, approaching a full scan`);
    // 搅动确实发生了递补：除队列末尾一条外，其余搅动报名都已录取或撤回。
    const insp = engine.inspect();
    for (const t of insp.tracks)
        strict_1.default.ok(t.occupied <= t.capacity);
    strict_1.default.equal(insp.tracks.find((t) => t.id === "HOT").occupied, 1);
    const churnAdmitted = insp.registrations.filter((r) => r.id > BLOCKED_COUNT + 1 && r.status === "admitted").length;
    strict_1.default.equal(churnAdmitted, 1); // 每轮录取 1 条又撤回，最终只剩最后一条在册
    const waiting = insp.registrations.filter((r) => r.status === "waiting");
    strict_1.default.ok(waiting.length >= BLOCKED_COUNT);
});
