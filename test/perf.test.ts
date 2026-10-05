import test from 'node:test';
import assert from 'node:assert/strict';
import { createSplineScene } from '../src/index.js';
import type { Point, Region, Spline } from '../src/index.js';

/** 确定性伪随机数（mulberry32），保证测试可复现。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function regularPolygon(cx: number, cy: number, r: number, n: number, phase = 0): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (2 * Math.PI * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

const SPLINE_COUNT = 2000;
const SEGS_PER_SPLINE = 8;

function buildScene(): { region: Region; splines: Spline[] } {
  // 外环 48 边形 + 两个 8 边形孔洞 = 64 条边
  const region: Region = {
    outer: regularPolygon(0, 0, 5000, 48),
    holes: [
      regularPolygon(2000, 0, 1000, 8, Math.PI / 8),
      regularPolygon(-2000, 0, 1000, 8, Math.PI / 8),
    ],
  };

  const rand = mulberry32(42);
  const splines: Spline[] = [];
  for (let i = 0; i < SPLINE_COUNT; i++) {
    // 一半样条在选区附近（触发完整裁剪），一半散布在 ±100000 英尺（包围盒快速排除）
    const local = i % 2 === 0;
    const cx = local ? (rand() - 0.5) * 12000 : (rand() - 0.5) * 200000;
    const cy = local ? (rand() - 0.5) * 12000 : (rand() - 0.5) * 200000;
    const segments = [];
    let px = cx;
    let py = cy;
    for (let s = 0; s < SEGS_PER_SPLINE; s++) {
      const nx = px + (rand() - 0.5) * 4000;
      const ny = py + (rand() - 0.5) * 4000;
      segments.push({
        p0: { x: px, y: py },
        p1: { x: px + (rand() - 0.5) * 3000, y: py + (rand() - 0.5) * 3000 },
        p2: { x: nx + (rand() - 0.5) * 3000, y: ny + (rand() - 0.5) * 3000 },
        p3: { x: nx, y: ny },
      });
      px = nx;
      py = ny;
    }
    splines.push({ id: `spline-${i}`, segments });
  }
  return { region, splines };
}

test('性能：2000 条样条 x 8 段，64 边选区，单次选取 < 5 秒', () => {
  const { region, splines } = buildScene();
  const scene = createSplineScene();
  scene.loadSplines([...splines]); // 装入耗时不计入

  const t0 = Date.now();
  const hits = scene.select(region, 'intersect');
  const t1 = Date.now();
  const contained = scene.select(region, 'contain');
  const t2 = Date.now();

  const intersectMs = t1 - t0;
  const containMs = t2 - t1;
  console.log(
    `[perf] intersect: ${intersectMs}ms (${hits.length} hits), ` +
    `contain: ${containMs}ms (${contained.length} hits), ` +
    `${SPLINE_COUNT} splines x ${SEGS_PER_SPLINE} segments, 64-edge region`,
  );

  assert.ok(hits.length > 0, 'expected some intersect hits');
  for (const h of hits) {
    for (const iv of h.intervals) {
      assert.ok(iv.start >= 0 && iv.end <= SEGS_PER_SPLINE && iv.start <= iv.end);
    }
  }
  assert.ok(intersectMs < 5000, `intersect took ${intersectMs}ms`);
  assert.ok(containMs < 5000, `contain took ${containMs}ms`);
});
