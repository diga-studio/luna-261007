import { clipSegmentToRegion, prepareRegion } from "./segmentClip.js";
/** 进程内存中的样条场景，由上层画布批量装入并执行区域选取。 */
export class SplineScene {
    splines = [];
    /** 批量装入样条，替换原有场景内容。 */
    loadSplines(splines) {
        this.splines = [...splines];
    }
    /**
     * 按选区选取样条。
     * - intersect：样条上至少一个点属于选区（含孤立接触点）。
     * - contain：样条上所有点都属于选区（区间覆盖完整参数域 [0, 段数]）。
     */
    select(region, mode) {
        const hits = [];
        const prepared = prepareRegion(region.outer, region.holes);
        for (const spline of this.splines) {
            const n = spline.segments.length;
            if (n === 0)
                continue;
            // 各段局部区间平移为全局参数后合并（跨段连接点只保留一份）
            const merged = [];
            for (let i = 0; i < n; i++) {
                const local = clipSegmentToRegion(spline.segments[i], prepared);
                for (const iv of local) {
                    const g = { start: iv.start + i, end: iv.end + i };
                    const last = merged[merged.length - 1];
                    if (last && g.start <= last.end) {
                        if (g.end > last.end)
                            last.end = g.end;
                    }
                    else {
                        merged.push(g);
                    }
                }
            }
            if (merged.length === 0)
                continue;
            if (mode === "contain") {
                const coversAll = merged.length === 1 && merged[0].start === 0 && merged[0].end === n;
                if (!coversAll)
                    continue;
            }
            hits.push({ id: spline.id, intervals: merged });
        }
        return hits;
    }
}
