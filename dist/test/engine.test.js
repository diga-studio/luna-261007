"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const engine_1 = require("../src/engine");
function admittedIds(insp) {
    return insp.registrations.filter((r) => r.status === "admitted").map((r) => r.id);
}
function waitingIds(insp) {
    return insp.registrations.filter((r) => r.status === "waiting").map((r) => r.id);
}
function occupied(insp, trackId) {
    return insp.tracks.find((t) => t.id === trackId).occupied;
}
(0, node_test_1.test)("队首团队人数过多不阻塞后续小团队递补", () => {
    const engine = new engine_1.WaitlistEngine([{ id: "A", capacity: 4 }], []);
    const big = engine.register("A", ["m1", "m2", "m3", "m4", "m5"]); // 5 人 > 容量 4
    const small1 = engine.register("A", ["a1", "a2"]);
    const small2 = engine.register("A", ["b1"]);
    let insp = engine.inspect();
    strict_1.default.deepEqual(admittedIds(insp), [small1, small2]);
    strict_1.default.deepEqual(waitingIds(insp), [big]);
    strict_1.default.equal(occupied(insp, "A"), 3);
    // 再来 1 人队，恰好填满容量 4；队首 5 人队仍保留原序号等待。
    const small3 = engine.register("A", ["c1"]);
    insp = engine.inspect();
    strict_1.default.deepEqual(admittedIds(insp), [small1, small2, small3]);
    strict_1.default.deepEqual(waitingIds(insp), [big]);
    strict_1.default.equal(occupied(insp, "A"), 4);
    // 撤回两个 1 人队后空出 2 个位置，队首 5 人队仍放不下，不得录取。
    engine.withdraw(small2);
    engine.withdraw(small3);
    insp = engine.inspect();
    strict_1.default.deepEqual(admittedIds(insp), [small1]);
    strict_1.default.deepEqual(waitingIds(insp), [big]);
    strict_1.default.equal(occupied(insp, "A"), 2);
});
(0, node_test_1.test)("撤回 A 后更早的 B 候补先录取并阻断 A，C 不受影响继续递补", () => {
    // 冲突：A<->B（对称）。C 与两者都不冲突。冲突不具传递性。
    const engine = new engine_1.WaitlistEngine([
        { id: "A", capacity: 2 },
        { id: "B", capacity: 1 },
        { id: "C", capacity: 1 },
    ], [["A", "B"]]);
    // 先占满 A：x 独享 A 的 2 个名额。
    const aOccupier = engine.register("A", ["x", "y"]);
    // B 的候补：成员 p（与任何人都不重叠）。
    const bWaiter = engine.register("B", ["p"]);
    // A 的候补：成员 p —— 若 bWaiter 先录取，p 在 B 赛道被录取，而 A 与 B 冲突，
    // 因此该 A 候补会被阻断。
    const aWaiter = engine.register("A", ["p"]);
    // C 的候补：成员 q，与 A/B 均不冲突。
    const cWaiter = engine.register("C", ["q"]);
    let insp = engine.inspect();
    // B、C 容量空闲且无冲突，注册即录取；A 候补因 p 已录取到 B（A∼B 冲突）而等待。
    strict_1.default.deepEqual(admittedIds(insp), [aOccupier, bWaiter, cWaiter]);
    strict_1.default.deepEqual(waitingIds(insp), [aWaiter]);
    // 撤回 bWaiter 并不能让 aWaiter 录取：A 仍被 aOccupier 占满（容量不足）。
    // 重新构造一个更贴切的场景：撤回 A 的占用者，释放 A 的容量。
    // 但 bWaiter 已录取在 B，p 被占用，aWaiter 仍被成员冲突阻断。
    engine.withdraw(aOccupier);
    insp = engine.inspect();
    strict_1.default.deepEqual(waitingIds(insp), [aWaiter]);
    strict_1.default.equal(occupied(insp, "A"), 0);
    // 撤回 B 的 bWaiter 后 p 被释放，aWaiter 立即递补进 A。
    engine.withdraw(bWaiter);
    insp = engine.inspect();
    strict_1.default.deepEqual(admittedIds(insp), [aWaiter, cWaiter]);
    strict_1.default.equal(occupied(insp, "A"), 1);
    strict_1.default.equal(occupied(insp, "C"), 1);
});
(0, node_test_1.test)("撤回已录取报名后，更早的其它赛道候补先录取并反过来阻断本赛道候补", () => {
    // A 容量 1，B 容量 1，A<->B 冲突。
    const engine = new engine_1.WaitlistEngine([
        { id: "A", capacity: 1 },
        { id: "B", capacity: 1 },
    ], [["A", "B"]]);
    // x 先占满 B。
    const bOccupier = engine.register("B", ["x"]);
    // 候补1（更早）：赛道 B，成员 u。等 x 让位。
    const earlierB = engine.register("B", ["u"]);
    // 候补2（更晚）：赛道 A，成员 u。u 与候补1 共享。
    const laterA = engine.register("A", ["u"]);
    // 候补3：赛道 A，成员 v（不重叠）。
    const otherA = engine.register("A", ["v"]);
    let insp = engine.inspect();
    // A 空着且 v 无冲突：otherA 立即录取。laterA 因 u 尚未被占用……
    // u 当前没有任何已录取报名，因此 laterA 在注册时即被录取进 A？
    // ——A 容量 1，otherA 与 laterA 谁序号小谁先：laterA(3) < otherA(4)，laterA 先占 A。
    strict_1.default.deepEqual(admittedIds(insp), [bOccupier, laterA]);
    strict_1.default.deepEqual(waitingIds(insp), [earlierB, otherA]);
    // 撤回 B 的占用者 x：候补1 earlierB（序号2）可录取进 B；u 被 B 占用后，
    // 已录取的 laterA 不受影响（已录取不被挤出），但 u 同时录取在 A 与 B？
    // 不允许：u 录取到 B 时，u 已有 A 的已录取报名，A∼B 冲突，故 earlierB 不可录取。
    engine.withdraw(bOccupier);
    insp = engine.inspect();
    strict_1.default.deepEqual(admittedIds(insp), [laterA]);
    strict_1.default.deepEqual(waitingIds(insp), [earlierB, otherA]);
    strict_1.default.equal(occupied(insp, "B"), 0);
    // 撤回 laterA：u 从 A 释放。此时 earlierB（序号2）与 otherA（序号4）都可录取，
    // 序号更小者优先：earlierB 进 B，u 被 B 占用；otherA 成员是 v，不受影响，进 A。
    engine.withdraw(laterA);
    insp = engine.inspect();
    strict_1.default.deepEqual(admittedIds(insp), [earlierB, otherA]);
    strict_1.default.equal(occupied(insp, "A"), 1);
    strict_1.default.equal(occupied(insp, "B"), 1);
});
(0, node_test_1.test)("inspect 不改变状态；撤回候补不触发任何录取", () => {
    const engine = new engine_1.WaitlistEngine([{ id: "A", capacity: 1 }], []);
    const r1 = engine.register("A", ["a"]);
    const r2 = engine.register("A", ["b"]);
    const before = engine.inspect();
    const again = engine.inspect();
    strict_1.default.deepEqual(again, before);
    engine.withdraw(r2); // 撤回的是候补，无人可递补
    const insp = engine.inspect();
    strict_1.default.deepEqual(admittedIds(insp), [r1]);
    strict_1.default.equal(insp.registrations.find((r) => r.id === r2).status, "withdrawn");
});
(0, node_test_1.test)("创建序号严格递增且等于报名标识", () => {
    const engine = new engine_1.WaitlistEngine([{ id: "A", capacity: 10 }], []);
    const ids = [
        engine.register("A", ["a"]),
        engine.register("A", ["b"]),
        engine.register("A", ["c"]),
    ];
    strict_1.default.deepEqual(ids, [1, 2, 3]);
    engine.withdraw(ids[1]);
    const id4 = engine.register("A", ["d"]);
    strict_1.default.equal(id4, 4);
    const insp = engine.inspect();
    strict_1.default.equal(insp.registrations.find((r) => r.id === id4).seq, 4);
});
(0, node_test_1.test)("非法输入被拒绝", () => {
    const engine = new engine_1.WaitlistEngine([{ id: "A", capacity: 2 }], []);
    strict_1.default.throws(() => engine.register("A", []));
    strict_1.default.throws(() => engine.register("A", ["x", "x"]));
    strict_1.default.throws(() => engine.register("A", Array.from({ length: 21 }, (_, i) => `m${i}`)));
    strict_1.default.throws(() => engine.register("B", ["x"]));
    strict_1.default.throws(() => engine.withdraw(999));
    const r = engine.register("A", ["x"]);
    engine.withdraw(r);
    strict_1.default.throws(() => engine.withdraw(r));
    strict_1.default.throws(() => new engine_1.WaitlistEngine(Array.from({ length: 65 }, (_, i) => ({ id: `T${i}`, capacity: 1 })), []));
});
