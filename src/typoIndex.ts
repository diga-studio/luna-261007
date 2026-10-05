import { isEditDistanceOne } from './editDistance.js';

/**
 * 删除邻域索引：编辑距离恰为 1 的两个词，必共享
 * “词本身或删除一个码点后的字符串”。
 * 查询时只生成查询词的 O(len) 个键做二分查找，再对候选做精确验证，
 * 不遍历全词表。
 */
export interface TypoIndex {
  /** 返回词表中与 term 编辑距离恰为 1 的词元 id。 */
  neighbors(term: string): number[];
}

export function buildTypoIndex(vocab: string[]): TypoIndex {
  const vocabCps = vocab.map((w) => Array.from(w));

  // 收集 (key, termId)：词本身 + 所有删除一个码点的变体
  let total = 0;
  const perTermKeys: string[][] = new Array(vocab.length);
  for (let t = 0; t < vocab.length; t++) {
    const cps = vocabCps[t]!;
    const keys = new Set<string>();
    keys.add(vocab[t]!);
    for (let i = 0; i < cps.length; i++) {
      keys.add(cps.slice(0, i).join('') + cps.slice(i + 1).join(''));
    }
    perTermKeys[t] = [...keys];
    total += perTermKeys[t]!.length;
  }

  const allKeys = new Array<string>(total);
  const allTids = new Uint32Array(total);
  let p = 0;
  for (let t = 0; t < vocab.length; t++) {
    for (const key of perTermKeys[t]!) {
      allKeys[p] = key;
      allTids[p] = t;
      p++;
    }
  }

  // 按 key 排序的 CSR：uniqKeys + offsets + tids
  const order = new Uint32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  order.sort((x, y) => {
    const a = allKeys[x]!;
    const b = allKeys[y]!;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const uniqKeys: string[] = [];
  const offsets: number[] = [0];
  const tids = new Uint32Array(total);
  for (let i = 0; i < total; i++) {
    const key = allKeys[order[i]!]!;
    tids[i] = allTids[order[i]!]!;
    if (uniqKeys.length === 0 || uniqKeys[uniqKeys.length - 1] !== key) {
      while (offsets.length < uniqKeys.length + 1) offsets.push(i);
      uniqKeys.push(key);
    }
  }
  offsets.push(total);

  const keys = uniqKeys;
  const offs = Uint32Array.from(offsets);

  /** 二分查找 key 的下标，未命中返回 -1。 */
  const findKey = (key: string): number => {
    let lo = 0;
    let hi = keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = keys[mid]!;
      if (k === key) return mid;
      if (k < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  };

  return {
    neighbors(term: string): number[] {
      const cps = Array.from(term);
      const queryKeys = new Set<string>();
      queryKeys.add(term);
      for (let i = 0; i < cps.length; i++) {
        queryKeys.add(cps.slice(0, i).join('') + cps.slice(i + 1).join(''));
      }
      const seen = new Set<number>();
      const out: number[] = [];
      for (const key of queryKeys) {
        const idx = findKey(key);
        if (idx < 0) continue;
        const end = offs[idx + 1]!;
        for (let j = offs[idx]!; j < end; j++) {
          const tid = tids[j]!;
          if (seen.has(tid)) continue;
          seen.add(tid);
          if (isEditDistanceOne(cps, vocabCps[tid]!)) out.push(tid);
        }
      }
      return out;
    },
  };
}
