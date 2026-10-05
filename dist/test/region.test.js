import assert from "node:assert/strict";
import test from "node:test";
import { SplineScene } from "../src/scene.js";
/**
 * 凹形选区：底边中部被挖去 x∈[6.5,8.5], y∈[0,2] 的矩形凹槽；
 * 孔洞：[4,6]×[3,7]。
 */
const REGION = {
    outer: [
        { x: 0, y: 0 },
        { x: 6.5, y: 0 },
        { x: 6.5, y: 2 },
        { x: 8.5, y: 2 },
        { x: 8.5, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
    ],
    holes: [
        [
            { x: 4, y: 3 },
            { x: 6, y: 3 },
            { x: 6, y: 7 },
            { x: 4, y: 7 },
        ],
    ],
};
/** 被测曲线：x(t) 单调 1→9，y(t) = 5 + 60·t(1-t)(1-2t)，两次越过顶边、
 *  穿过孔洞、再两次越过凹槽边。首尾 (1,5)、(9,5) 均在区内。 */
const CURVE = {
    p0: { x: 1, y: 5 },
    p1: { x: 3, y: 25 },
    p2: { x: 7, y: -15 },
    p3: { x: 9, y: 5 },
};
function xOf(t) {
    const u = 1 - t;
    return u * u * u + 9 * u * u * t + 21 * u * t * t + 9 * t * t * t;
}
function yOf(t) {
    return 5 + 60 * t * (1 - t) * (1 - 2 * t);
}
/** 独立求解：在 [lo,hi] 内用二分法求 f 的唯一零点（与库内解析求根无关）。 */
function solveByBisection(f, lo, hi) {
    let flo = f(lo);
    for (let i = 0; i < 200; i++) {
        const mid = (lo + hi) / 2;
        const fm = f(mid);
        if (Math.sign(fm) === Math.sign(flo)) {
            lo = mid;
            flo = fm;
        }
        else {
            hi = mid;
        }
    }
    return (lo + hi) / 2;
}
function assertIntervals(actual, expected, tol = 1e-9) {
    assert.equal(actual.length, expected.length, `interval count: got ${JSON.stringify(actual)}`);
    for (let i = 0; i < expected.length; i++) {
        assert.ok(Math.abs(actual[i].start - expected[i][0]) <= tol, `interval ${i} start: got ${actual[i].start}, want ${expected[i][0]}`);
        assert.ok(Math.abs(actual[i].end - expected[i][1]) <= tol, `interval ${i} end: got ${actual[i].end}, want ${expected[i][1]}`);
    }
}
test("凹形选区带孔洞：单段多次进出且首尾均在区内", () => {
    // 独立计算各事件参数（与库内实现互不相同的方法）
    const t1 = solveByBisection((t) => yOf(t) - 10, 0.05, 0.2); // 出区：顶边
    const t2 = solveByBisection((t) => yOf(t) - 10, 0.3, 0.45); // 入区：顶边
    const t3 = solveByBisection((t) => yOf(t) - 7, 0.4, 0.48); // 入孔洞：孔洞顶边
    const t4 = solveByBisection((t) => yOf(t) - 3, 0.52, 0.6); // 出孔洞：孔洞底边
    const ta = solveByBisection((t) => xOf(t) - 6.5, 0.6, 0.75); // 出区：凹槽左边
    const tb = solveByBisection((t) => xOf(t) - 8.5, 0.85, 0.95); // 入区：凹槽右边
    const spline = { id: "weave", segments: [CURVE] };
    const scene = new SplineScene();
    scene.loadSplines([spline]);
    const hits = scene.select(REGION, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [
        [0, t1],
        [t2, t3],
        [t4, ta],
        [tb, 1],
    ]);
    // 首尾均在区内但中途出区 => 完全包含不得选中
    assert.equal(scene.select(REGION, "contain").length, 0);
});
test("完全包含：整段在区内的样条被 contain 选中", () => {
    const inside = {
        id: "inside",
        segments: [
            {
                p0: { x: 2, y: 8.5 },
                p1: { x: 2.4, y: 8.6 },
                p2: { x: 2.6, y: 8.4 },
                p3: { x: 3, y: 8.5 },
            },
        ],
    };
    const scene = new SplineScene();
    scene.loadSplines([inside]);
    const hits = scene.select(REGION, "contain");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [[0, 1]]);
});
