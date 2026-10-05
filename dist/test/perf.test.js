import assert from "node:assert/strict";
import test from "node:test";
import { SplineScene } from "../src/scene.js";
/** 确定性伪随机数（LCG），保证结果可复现。 */
function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}
function regularRing(cx, cy, r, n, phase = 0) {
    const ring = [];
    for (let i = 0; i < n; i++) {
        const a = phase + (2 * Math.PI * i) / n;
        ring.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
    return ring;
}
test("性能：2000 条样条 × 8 段，64 边选区，单次选取 < 5s", () => {
    const rng = makeRng(42);
    const splines = [];
    for (let i = 0; i < 2000; i++) {
        const segments = [];
        let x = (rng() * 2 - 1) * 100000;
        let y = (rng() * 2 - 1) * 100000;
        for (let j = 0; j < 8; j++) {
            const nx = (rng() * 2 - 1) * 100000;
            const ny = (rng() * 2 - 1) * 100000;
            segments.push({
                p0: { x, y },
                p1: { x: x + (rng() * 2 - 1) * 40000, y: y + (rng() * 2 - 1) * 40000 },
                p2: { x: nx + (rng() * 2 - 1) * 40000, y: ny + (rng() * 2 - 1) * 40000 },
                p3: { x: nx, y: ny },
            });
            x = nx;
            y = ny;
        }
        splines.push({ id: `spline-${i}`, segments });
    }
    // 外环 48 边 + 两个 8 边孔洞 = 64 条边
    const region = {
        outer: regularRing(0, 0, 80000, 48),
        holes: [regularRing(-30000, 0, 12000, 8), regularRing(30000, 10000, 9000, 8, 0.3)],
    };
    const totalEdges = region.outer.length + region.holes.reduce((s, h) => s + h.length, 0);
    assert.ok(totalEdges <= 64);
    const scene = new SplineScene();
    scene.loadSplines(splines);
    const t0 = performance.now();
    const hits = scene.select(region, "intersect");
    const elapsed = performance.now() - t0;
    console.log(`select(intersect): ${elapsed.toFixed(1)}ms, hits=${hits.length}, ` +
        `intervals=${hits.reduce((s, h) => s + h.intervals.length, 0)}`);
    const t1 = performance.now();
    const containHits = scene.select(region, "contain");
    const elapsedContain = performance.now() - t1;
    console.log(`select(contain): ${elapsedContain.toFixed(1)}ms, hits=${containHits.length}`);
    assert.ok(hits.length > 0, "expected some hits");
    assert.ok(elapsed < 5000, `intersect select took ${elapsed.toFixed(1)}ms (> 5000ms)`);
    assert.ok(elapsedContain < 5000, `contain select took ${elapsedContain.toFixed(1)}ms (> 5000ms)`);
});
