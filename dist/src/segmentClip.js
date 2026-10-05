import { cubicRoots01, evalCubic, pointInRegion } from "./geometry.js";
export function prepareRegion(outer, holes) {
    const rings = [outer, ...holes];
    return { outer, holes, edges: buildEdges(rings) };
}
function buildEdges(rings) {
    const edges = [];
    for (const ring of rings) {
        const n = ring.length;
        for (let i = 0; i < n; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % n];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const len = Math.hypot(dx, dy);
            if (len === 0)
                continue;
            edges.push({
                ax: a.x,
                ay: a.y,
                dx,
                dy,
                len,
                minX: Math.min(a.x, b.x),
                minY: Math.min(a.y, b.y),
                maxX: Math.max(a.x, b.x),
                maxY: Math.max(a.y, b.y),
            });
        }
    }
    return edges;
}
/**
 * 计算单段三次贝塞尔中心线落在选区内的最大闭参数区间（局部参数 0..1）。
 *
 * 思路：曲线相对每条选区边的有向叉积是 t 的三次多项式，求根得到曲线
 * 进出选区的全部候选参数；把 [0,1] 切成原子区间/原子点后分别做
 * 点属选区判定，再把相邻的“在内”原子合并为最大闭区间。
 * 与边共线的曲线段单独处理：投影边端点到曲线参数上作为切分点，
 * 重叠部分由中点判定（边界属于选区）自然保留。
 */
export function clipSegmentToRegion(seg, region) {
    const { outer, holes, edges } = region;
    const pts = [seg.p0, seg.p1, seg.p2, seg.p3];
    let cMinX = Infinity;
    let cMinY = Infinity;
    let cMaxX = -Infinity;
    let cMaxY = -Infinity;
    let coordScale = 1;
    for (const p of pts) {
        if (p.x < cMinX)
            cMinX = p.x;
        if (p.y < cMinY)
            cMinY = p.y;
        if (p.x > cMaxX)
            cMaxX = p.x;
        if (p.y > cMaxY)
            cMaxY = p.y;
        const ax = Math.abs(p.x);
        const ay = Math.abs(p.y);
        if (ax > coordScale)
            coordScale = ax;
        if (ay > coordScale)
            coordScale = ay;
    }
    const distTol = 1e-9 * coordScale;
    // 收集切分参数
    const splits = [0, 1];
    for (const e of edges) {
        // 包围盒预筛（控制点凸包包含曲线）
        if (cMaxX < e.minX - distTol ||
            cMinX > e.maxX + distTol ||
            cMaxY < e.minY - distTol ||
            cMinY > e.maxY + distTol) {
            continue;
        }
        // 控制点到边有向直线的叉积（未归一化）
        const c0 = (pts[0].x - e.ax) * e.dy - (pts[0].y - e.ay) * e.dx;
        const c1 = (pts[1].x - e.ax) * e.dy - (pts[1].y - e.ay) * e.dx;
        const c2 = (pts[2].x - e.ax) * e.dy - (pts[2].y - e.ay) * e.dx;
        const c3 = (pts[3].x - e.ax) * e.dy - (pts[3].y - e.ay) * e.dx;
        const crossTol = distTol * e.len;
        const maxAbsC = Math.max(Math.abs(c0), Math.abs(c1), Math.abs(c2), Math.abs(c3));
        if (maxAbsC <= crossTol) {
            // 曲线与边共线：把边的两个端点投影到曲线参数上作为切分点。
            // 解 dot(p(t) - endpoint, d) = 0（t 的三次多项式）。
            for (const [ex, ey] of [
                [e.ax, e.ay],
                [e.ax + e.dx, e.ay + e.dy],
            ]) {
                const d0 = (pts[0].x - ex) * e.dx + (pts[0].y - ey) * e.dy;
                const d1 = (pts[1].x - ex) * e.dx + (pts[1].y - ey) * e.dy;
                const d2 = (pts[2].x - ex) * e.dx + (pts[2].y - ey) * e.dy;
                const d3 = (pts[3].x - ex) * e.dx + (pts[3].y - ey) * e.dy;
                const roots = cubicRoots01(-d0 + 3 * d1 - 3 * d2 + d3, 3 * d0 - 6 * d1 + 3 * d2, -3 * d0 + 3 * d1, d0);
                for (const r of roots)
                    splits.push(r);
            }
            continue;
        }
        // 一般情形：解 cross(p(t) - a, d) = 0
        const roots = cubicRoots01(-c0 + 3 * c1 - 3 * c2 + c3, 3 * c0 - 6 * c1 + 3 * c2, -3 * c0 + 3 * c1, c0);
        for (const r of roots) {
            const p = evalCubic(seg.p0, seg.p1, seg.p2, seg.p3, r);
            // 交点必须落在边线段上（容差内）
            const cross = (p.x - e.ax) * e.dy - (p.y - e.ay) * e.dx;
            if (Math.abs(cross) > crossTol)
                continue;
            const s = ((p.x - e.ax) * e.dx + (p.y - e.ay) * e.dy) / (e.len * e.len);
            const sTol = distTol / e.len;
            if (s < -sTol || s > 1 + sTol)
                continue;
            splits.push(r);
        }
    }
    splits.sort((a, b) => a - b);
    const ts = [];
    for (const t of splits) {
        if (ts.length === 0 || t - ts[ts.length - 1] > 1e-11)
            ts.push(t);
    }
    // 原子判定：区间原子取中点，点原子取切分点本身
    const m = ts.length - 1;
    const intervalInside = new Array(m).fill(false);
    for (let i = 0; i < m; i++) {
        const a = ts[i];
        const b = ts[i + 1];
        const mid = (a + b) / 2;
        const p = evalCubic(seg.p0, seg.p1, seg.p2, seg.p3, mid);
        intervalInside[i] = pointInRegion(p, outer, holes);
    }
    const pointInside = new Array(ts.length).fill(false);
    for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (t === 0 || t === 1) {
            const p = evalCubic(seg.p0, seg.p1, seg.p2, seg.p3, t);
            pointInside[i] = pointInRegion(p, outer, holes);
        }
        else {
            // 内部切分点来自与边的求交或共线投影，按构造位于边界上（属选区）
            pointInside[i] = true;
        }
    }
    // 合并相邻的“在内”原子为最大闭区间
    const result = [];
    let curStart = null;
    let curEnd = null;
    const flush = () => {
        if (curStart !== null && curEnd !== null)
            result.push({ start: curStart, end: curEnd });
        curStart = null;
        curEnd = null;
    };
    // 首个点原子（t=0）
    if (pointInside[0]) {
        curStart = ts[0];
        curEnd = ts[0];
    }
    for (let i = 0; i < m; i++) {
        if (intervalInside[i]) {
            if (curStart === null)
                curStart = ts[i];
            curEnd = ts[i + 1];
        }
        else {
            flush();
        }
        // 点原子（位于本区间之后）
        if (pointInside[i + 1]) {
            const t = ts[i + 1];
            if (curStart === null) {
                curStart = t;
                curEnd = t;
            }
            else {
                curEnd = t;
            }
        }
        else {
            flush();
        }
    }
    flush();
    return result;
}
