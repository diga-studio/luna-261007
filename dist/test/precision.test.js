import assert from "node:assert/strict";
import test from "node:test";
import { SplineScene } from "../src/scene.js";
function lineSeg(x0, y0, x1, y1) {
    const at = (t) => ({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t });
    return { p0: at(0), p1: at(1 / 3), p2: at(2 / 3), p3: at(1) };
}
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
const BIG_SQUARE = {
    outer: [
        { x: 0, y: 0 },
        { x: 10000, y: 0 },
        { x: 10000, y: 10000 },
        { x: 0, y: 10000 },
    ],
    holes: [],
};
test("短间隙 1e-7：穿过细孔洞，间隙不得被合并", () => {
    // 细孔洞：x∈[5000, 5000.001]，曲线速度 10000 ft/单位参数 => 间隙宽 1e-7
    const region = {
        outer: BIG_SQUARE.outer,
        holes: [
            [
                { x: 5000, y: 4999 },
                { x: 5000.001, y: 4999 },
                { x: 5000.001, y: 5001 },
                { x: 5000, y: 5001 },
            ],
        ],
    };
    const spline = { id: "gap", segments: [lineSeg(0, 5000, 10000, 5000)] };
    const hits = selectOne(spline, region, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [[0, 0.5], [0.5000001, 1]]);
    assert.equal(selectOne(spline, region, "contain").length, 0);
});
test("短区间 1e-7：穿过细长凸出部，短区间不得遗漏", () => {
    // 外环右侧带细长凸出部：x∈[10000,10002], y∈[4999.9995,5000.0005]
    const region = {
        outer: [
            { x: 0, y: 0 },
            { x: 10000, y: 0 },
            { x: 10000, y: 4999.9995 },
            { x: 10002, y: 4999.9995 },
            { x: 10002, y: 5000.0005 },
            { x: 10000, y: 5000.0005 },
            { x: 10000, y: 10000 },
            { x: 0, y: 10000 },
        ],
        holes: [],
    };
    // 竖直曲线 x=10001，只在凸出部内短暂进入选区
    const spline = { id: "tab", segments: [lineSeg(10001, 0, 10001, 10000)] };
    const hits = selectOne(spline, region, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [[0.49999995, 0.50000005]]);
});
test("跨段连接点在边界上：区间连续合并且不重复", () => {
    const square10 = {
        outer: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ],
        holes: [],
    };
    // 两段在边界点 (10,5) 相接，其余部分均在区内 => 合并为 [0,2]
    const spline = {
        id: "join",
        segments: [lineSeg(5, 5, 10, 5), lineSeg(10, 5, 5, 5)],
    };
    const hits = selectOne(spline, square10, "intersect");
    assert.equal(hits.length, 1);
    assertIntervals(hits[0].intervals, [[0, 2]]);
    assert.equal(selectOne(spline, square10, "contain").length, 1);
    // 两段在边界点相接但其余部分均在区外 => 仅一个孤立点区间 [1,1]
    const outside = {
        id: "join-out",
        segments: [lineSeg(15, 5, 10, 5), lineSeg(10, 5, 15, 5)],
    };
    const hits2 = selectOne(outside, square10, "intersect");
    assert.equal(hits2.length, 1);
    assertIntervals(hits2[0].intervals, [[1, 1]]);
});
test("多次经过同一坐标：不同参数不得因此合并", () => {
    const square10 = {
        outer: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 10 },
            { x: 0, y: 10 },
        ],
        holes: [],
    };
    // x(t) = 24(t-0.5)^2 + 6，沿 y=5 往返，(10,5) 等坐标各经过两次
    const seg = {
        p0: { x: 12, y: 5 },
        p1: { x: 4, y: 5 },
        p2: { x: 4, y: 5 },
        p3: { x: 12, y: 5 },
    };
    const spline = { id: "backtrack", segments: [seg] };
    const hits = selectOne(spline, square10, "intersect");
    assert.equal(hits.length, 1);
    const half = 1 / Math.sqrt(6);
    assertIntervals(hits[0].intervals, [[0.5 - half, 0.5 + half]]);
});
