import type { SynonymEdge } from './types.js';

export interface SynonymGraph {
  termId(name: string): number | undefined;
  /**
   * 从若干起点（词元 id -> 起始置信度）出发沿有向边多跳扩展。
   * 经过边后置信度为 floor(conf * w / 1000)，同一词元取各路径最大值，
   * 置信度为 0 不产生命中。由于边权 ≤1000（乘子 ≤1），
   * 用最大堆做 Dijkstra 式传播即可得到每个词元的最大置信度。
   */
  expand(starts: ReadonlyMap<number, number>): Map<number, number>;
}

export function buildSynonymGraph(vocab: string[], edges: SynonymEdge[]): SynonymGraph {
  if (vocab.length >= 1 << 21) throw new Error('vocabulary too large');
  const idOf = new Map<string, number>();
  for (let i = 0; i < vocab.length; i++) idOf.set(vocab[i]!, i);

  const n = vocab.length;
  const outDeg = new Uint32Array(n + 1);
  for (const e of edges) {
    const from = idOf.get(e.from);
    if (from === undefined) throw new Error(`synonym edge endpoint not in vocab: ${e.from}`);
    outDeg[from + 1]!++;
  }
  for (let i = 0; i < n; i++) outDeg[i + 1]! += outDeg[i]!;

  const adjTo = new Uint32Array(outDeg[n]!);
  const adjW = new Uint16Array(outDeg[n]!);
  const cursor = Uint32Array.from(outDeg.subarray(0, n));
  for (const e of edges) {
    const from = idOf.get(e.from)!;
    const to = idOf.get(e.to);
    if (to === undefined) throw new Error(`synonym edge endpoint not in vocab: ${e.to}`);
    const slot = cursor[from]!;
    adjTo[slot] = to;
    adjW[slot] = e.w;
    cursor[from] = slot + 1;
  }

  return {
    termId: (name: string) => idOf.get(name),

    expand(starts: ReadonlyMap<number, number>): Map<number, number> {
      const best = new Int32Array(n);
      // 堆元素打包为 conf * 2^21 + tid（conf ≤1000 < 2^11，tid < 2^21），
      // 数值越大置信度越高，直接当最大堆用。
      const SHIFT = 1 << 21;
      const heap: number[] = [];
      const push = (conf: number, tid: number): void => {
        heap.push(conf * SHIFT + tid);
        let i = heap.length - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (heap[parent]! >= heap[i]!) break;
          const tmp = heap[parent]!;
          heap[parent] = heap[i]!;
          heap[i] = tmp;
          i = parent;
        }
      };
      const pop = (): number => {
        const top = heap[0]!;
        const last = heap.pop()!;
        if (heap.length > 0) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const l = i * 2 + 1;
            const r = l + 1;
            let largest = i;
            if (l < heap.length && heap[l]! > heap[largest]!) largest = l;
            if (r < heap.length && heap[r]! > heap[largest]!) largest = r;
            if (largest === i) break;
            const tmp = heap[largest]!;
            heap[largest] = heap[i]!;
            heap[i] = tmp;
            i = largest;
          }
        }
        return top;
      };

      for (const [tid, conf] of starts) {
        if (conf > best[tid]!) {
          best[tid] = conf;
          push(conf, tid);
        }
      }

      while (heap.length > 0) {
        const packed = pop();
        const conf = Math.floor(packed / SHIFT);
        const tid = packed % SHIFT;
        if (conf < best[tid]!) continue;
        const end = outDeg[tid + 1]!;
        for (let e = outDeg[tid]!; e < end; e++) {
          const nconf = Math.floor((conf * adjW[e]!) / 1000);
          const to = adjTo[e]!;
          if (nconf > 0 && nconf > best[to]!) {
            best[to] = nconf;
            push(nconf, to);
          }
        }
      }

      const out = new Map<number, number>();
      for (let t = 0; t < n; t++) {
        if (best[t]! > 0) out.set(t, best[t]!);
      }
      return out;
    },
  };
}
