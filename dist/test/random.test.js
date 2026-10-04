"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const engine_1 = require("../src/engine");
const reference_1 = require("./reference");
/** 确定性伪随机数生成器（可复现）。 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function runRandomCase(seed, ops) {
    const rand = mulberry32(seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    // 4 条赛道，容量 1..6；冲突关系随机生成，保证非传递结构可能出现。
    const tracks = ["A", "B", "C", "D"].map((id) => ({
        id,
        capacity: 1 + Math.floor(rand() * 6),
    }));
    const conflicts = [];
    for (const [i, a] of tracks.entries()) {
        for (const b of tracks.slice(i + 1)) {
            if (rand() < 0.4)
                conflicts.push([a.id, b.id]);
        }
    }
    const engine = new engine_1.WaitlistEngine(tracks, conflicts);
    const reference = new reference_1.ReferenceEngine(tracks, conflicts);
    const liveIds = [];
    const memberPool = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const checkEqual = (ctx) => {
        const got = engine.inspect();
        const want = reference.inspect();
        strict_1.default.deepEqual(got.registrations.map((r) => [r.id, r.seq, r.trackId, r.status]), want.registrations.map((r) => [r.id, r.seq, r.trackId, r.status]), `registration mismatch (${ctx})`);
        strict_1.default.deepEqual(got.tracks, want.tracks, `track occupancy mismatch (${ctx})`);
        // 不变量：任何赛道不超容量。
        for (const t of got.tracks)
            strict_1.default.ok(t.occupied <= t.capacity);
    };
    for (let step = 0; step < ops; step++) {
        const doWithdraw = liveIds.length > 0 && rand() < 0.35;
        if (doWithdraw) {
            const idx = Math.floor(rand() * liveIds.length);
            const id = liveIds.splice(idx, 1)[0];
            engine.withdraw(id);
            reference.withdraw(id);
            checkEqual(`seed=${seed} step=${step} withdraw(${id})`);
        }
        else {
            const trackId = pick(tracks).id;
            const size = 1 + Math.floor(rand() * 4); // 1..4 人，便于多人重叠
            const members = new Set();
            while (members.size < size)
                members.add(pick(memberPool));
            const id = engine.register(trackId, [...members]);
            reference.register(trackId, [...members]);
            liveIds.push(id);
            checkEqual(`seed=${seed} step=${step} register(${trackId})`);
        }
    }
}
(0, node_test_1.test)("随机操作序列与全量扫描参考模型逐步一致", () => {
    for (let seed = 1; seed <= 30; seed++) {
        runRandomCase(seed, 120);
    }
});
