import assert from "node:assert/strict";
import test from "node:test";
import { SplineScene } from "../src/scene.js";
/** 生成退化为直线的三次贝塞尔段（控制点等距，参数化匀速）。 */
function lineSeg(x0, y0, x1, y1) {
    const at = (t) => ({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
    return { p0: at(0), p1: at(1 / 3), p2: at(2 / 3), p3: at(1) };
}
const SQUARE = {
    outer: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
    ],
    holes: [],
};
function selectOne(spline, region, mode) {
    const scene = new SplineScene();
    scene.loadSplines([spline]);
    return scene.select(region, mode);
}
function assertIntervals(actual, expected, tol = 1e-9) {
    assert.equal(actual.length, expected.length, `interval count: got ${JSON.stringify(actual)}`);
    for (let i = 0; i < expected.length; i++) {
        assert.ok(Math.abs(actual[i].start - expected[i][0]) <= tol, `interval ${i} start: got ${actual[i].start}, want ${expected[i][0]}`);
        assert.ok(Math.abs(actual[i].end - expected[i][1]) <= tol, `interval ${i} end: got ${actual[i].end}, want ${expected[i][1]}`);
    }
}
test("局部参数 0.5 处相切：返回单点区间", () => {
    // y(t) = 12t^2 - 12t + 13 = 12(t-0.5)^2 + 10 >= 10，仅在 t=0.5 触及顶边 y=10
    const seg = {
        p0: { x: 2, y: 13 },
        p1: { x: 2, y: 9 },
        p2: { x: 8, y: 9 },
        p3: { x: 8, y: 13 },
    };
    const spline = { id: "tangent", segments: [seg] };
    const hits = selectOne(spline, SQUARE, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [[0.5, 0.5]]);
    // 完全包含不得选中
    assert.equal(selectOne(spline, SQUARE, "contain").length, 0);
});
test("沿边界重叠：部分重叠返回重叠区间，整段在边界上返回完整区间", () => {
    // 与底边 y=0 共线，x 从 -4 到 6：重叠 x∈[0,6] 即 t∈[0.4,1]
    const partial = { id: "partial", segments: [lineSeg(-4, 0, 6, 0)] };
    const hits = selectOne(partial, SQUARE, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [[0.4, 1]]);
    // 整段位于底边上
    const full = { id: "full", segments: [lineSeg(2, 0, 8, 0)] };
    const hits2 = selectOne(full, SQUARE, "intersect");
    assert.equal(hits2.length, 1);
    assertIntervals(hits2[0].intervals, [[0, 1]]);
    // 整段在边界上 => 完全包含
    assert.equal(selectOne(full, SQUARE, "contain").length, 1);
});
test("整段退化为选区内一点：覆盖该段完整参数范围", () => {
    const p = { x: 5, y: 5 };
    const seg = { p0: p, p1: p, p2: p, p3: p };
    const spline = { id: "point", segments: [seg] };
    const hits = selectOne(spline, SQUARE, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [[0, 1]]);
    assert.equal(selectOne(spline, SQUARE, "contain").length, 1);
});
test("跨段连接点：区间内连续合并，连接点不重复返回", () => {
    // seg0: (5,5)->(8,5) 全在区内；seg1: (8,5)->(12,5)，x=10 处出区（局部 t=0.5）
    const spline = {
        id: "two-seg",
        segments: [lineSeg(5, 5, 8, 5), lineSeg(8, 5, 12, 5)],
    };
    const hits = selectOne(spline, SQUARE, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [[0, 1.5]]);
    assert.equal(selectOne(spline, SQUARE, "contain").length, 0);
});
test("闭合样条首尾同坐标：参数 0 与末端是不同位置，不得合并", () => {
    // 闭合两段样条，起点=终点=(10,5) 在右边界上，中间绕出区外再回来
    const sqrt15 = Math.sqrt(15);
    const spline = {
        id: "closed",
        segments: [
            // (10,5) -> 出区 -> (5,5)；x(t)=10+30t-30t^2-5t^3，x=10 于 t=0 与 t=√15-3
            { p0: { x: 10, y: 5 }, p1: { x: 20, y: 5 }, p2: { x: 20, y: 5 }, p3: { x: 5, y: 5 } },
            // (5,5) -> 出区 -> (10,5)；x(t)=5+45t-45t^2+5t^3，x=10 于 t=4-√15 与 t=1
            { p0: { x: 5, y: 5 }, p1: { x: 20, y: 5 }, p2: { x: 20, y: 5 }, p3: { x: 10, y: 5 } },
        ],
    };
    const hits = selectOne(spline, SQUARE, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [
        [0, 0],
        [sqrt15 - 3, 5 - sqrt15],
        [2, 2],
    ]);
});
test("孔洞内部不属于选区", () => {
    const region = {
        outer: SQUARE.outer,
        holes: [
            [
                { x: 2, y: 2 },
                { x: 8, y: 2 },
                { x: 8, y: 8 },
                { x: 2, y: 8 },
            ],
        ],
    };
    // 整段位于孔洞内部 => 不命中
    const inside = { id: "in-hole", segments: [lineSeg(3, 5, 7, 5)] };
    assert.equal(selectOne(inside, region, "intersect").length, 0);
    // 穿过孔洞：t∈[0.2,0.4] 在孔洞内（孔洞边界属选区）
    const through = { id: "through", segments: [lineSeg(0, 5, 10, 5)] };
    const hits = selectOne(through, region, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [[0, 0.2], [0.8, 1]]);
    assert.equal(selectOne(through, region, "contain").length, 0);
});
