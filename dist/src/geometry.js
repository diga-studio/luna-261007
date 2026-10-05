/** 求三次贝塞尔曲线在参数 t 处的点（de Casteljau）。 */
export function evalCubic(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return {
        x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
        y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
    };
}
/** 三次贝塞尔曲线的导数在参数 t 处的值。 */
export function evalCubicDeriv(p0, p1, p2, p3, t) {
    const u = 1 - t;
    return {
        x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
        y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
    };
}
/** 一元二次方程在 [0,1] 内的实根。 */
function quadraticRoots01(a2, a1, a0, out) {
    if (a2 === 0) {
        if (a1 !== 0)
            out.push(-a0 / a1);
        return;
    }
    const disc = a1 * a1 - 4 * a2 * a0;
    if (disc < 0) {
        // 精确相切在浮点下可能得到极小的负判别式，按重根处理
        const scale = a1 * a1 + 4 * Math.abs(a2 * a0);
        if (disc < -1e-12 * scale)
            return;
        out.push(-a1 / (2 * a2));
        return;
    }
    if (disc === 0) {
        out.push(-a1 / (2 * a2));
        return;
    }
    const sq = Math.sqrt(disc);
    // 数值稳定的求根形式
    const q = -0.5 * (a1 + Math.sign(a1) * sq);
    const r1 = q / a2;
    const r2 = a2 !== 0 ? a0 / q : NaN;
    if (Number.isFinite(r1))
        out.push(r1);
    if (Number.isFinite(r2))
        out.push(r2);
}
/**
 * 求三次多项式 a3 t^3 + a2 t^2 + a1 t + a0 = 0 在 [0,1] 内的实根（升序、去重）。
 * 解析求解后再用牛顿法对原多项式做精化。
 */
export function cubicRoots01(a3, a2, a1, a0) {
    const raw = [];
    if (a3 === 0) {
        quadraticRoots01(a2, a1, a0, raw);
    }
    else {
        // 归一化为 t^3 + a t^2 + b t + c
        const a = a2 / a3;
        const b = a1 / a3;
        const c = a0 / a3;
        //  depressed cubic: t = u - a/3 -> u^3 + p u + q
        const p = b - (a * a) / 3;
        const q = (2 * a * a * a) / 27 - (a * b) / 3 + c;
        const offset = a / 3;
        const disc = (q * q) / 4 + (p * p * p) / 27;
        if (disc > 0) {
            const sq = Math.sqrt(disc);
            const u = Math.cbrt(-q / 2 + sq) + Math.cbrt(-q / 2 - sq);
            raw.push(u - offset);
        }
        else if (disc === 0) {
            const u = Math.cbrt(-q / 2);
            raw.push(2 * u - offset, -u - offset);
        }
        else {
            // 三个实根：三角法
            const m = 2 * Math.sqrt(-p / 3);
            const theta = Math.acos((3 * q) / (p * m)) / 3;
            const k = (2 * Math.PI) / 3;
            raw.push(m * Math.cos(theta) - offset, m * Math.cos(theta - k) - offset, m * Math.cos(theta - 2 * k) - offset);
        }
    }
    const poly = (t) => ((a3 * t + a2) * t + a1) * t + a0;
    const deriv = (t) => (3 * a3 * t + 2 * a2) * t + a1;
    const roots = [];
    for (let r of raw) {
        if (!Number.isFinite(r))
            continue;
        // 牛顿精化（在原多项式上），限制在 [0,1] 附近
        for (let i = 0; i < 8; i++) {
            const f = poly(r);
            if (f === 0)
                break;
            const df = deriv(r);
            if (df === 0)
                break;
            const next = r - f / df;
            if (next === r)
                break;
            r = next;
        }
        if (r < -1e-12 || r > 1 + 1e-12)
            continue;
        if (r < 0)
            r = 0;
        if (r > 1)
            r = 1;
        roots.push(r);
    }
    roots.sort((x, y) => x - y);
    const dedup = [];
    for (const r of roots) {
        if (dedup.length === 0 || r - dedup[dedup.length - 1] > 1e-11)
            dedup.push(r);
    }
    return dedup;
}
/** 判断点是否在线段 ab 上（含端点），容差随坐标尺度缩放。 */
function pointOnSegment(p, a, b, tol) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const cross = abx * apy - aby * apx;
    const len = Math.hypot(abx, aby);
    if (Math.abs(cross) > tol * Math.max(len, 1))
        return false;
    const dot = apx * abx + apy * aby;
    if (dot < -tol * len)
        return false;
    const lenSq = len * len;
    if (dot - lenSq > tol * len)
        return false;
    return true;
}
function ringScale(ring) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const v of ring) {
        if (v.x < minX)
            minX = v.x;
        if (v.y < minY)
            minY = v.y;
        if (v.x > maxX)
            maxX = v.x;
        if (v.y > maxY)
            maxY = v.y;
    }
    return Math.max(maxX - minX, maxY - minY, 1);
}
/** 点是否在环边界上（容差内）。 */
function pointOnRing(p, ring, tol) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
        const a = ring[i];
        const b = ring[(i + 1) % n];
        if (pointOnSegment(p, a, b, tol))
            return true;
    }
    return false;
}
/** 射线法：点是否在简单多边形内部（不含边界）。 */
function pointInRingInterior(p, ring) {
    const n = ring.length;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const vi = ring[i];
        const vj = ring[j];
        if (vi.y > p.y !== vj.y > p.y) {
            const xCross = ((vj.x - vi.x) * (p.y - vi.y)) / (vj.y - vi.y) + vi.x;
            if (p.x < xCross)
                inside = !inside;
        }
    }
    return inside;
}
/**
 * 点是否属于选区（外环内部含边界，减去孔洞内部；孔洞边界仍属选区）。
 */
export function pointInRegion(p, outer, holes) {
    const tolOuter = 1e-9 * ringScale(outer);
    if (pointOnRing(p, outer, tolOuter))
        return true;
    for (const hole of holes) {
        const tolHole = 1e-9 * ringScale(hole);
        if (pointOnRing(p, hole, tolHole))
            return true;
    }
    if (!pointInRingInterior(p, outer))
        return false;
    for (const hole of holes) {
        if (pointInRingInterior(p, hole))
            return false;
    }
    return true;
}
