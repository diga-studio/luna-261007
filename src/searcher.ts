import { buildInvertedIndex, FieldCollector, type InvertedIndex } from './invertedIndex.js';
import { buildSynonymGraph } from './synonymGraph.js';
import { buildTypoIndex } from './typoIndex.js';
import {
  EXACT_CONFIDENCE,
  FIELD_NAMES,
  FIELD_WEIGHTS,
  TYPO_CONFIDENCE,
  type FieldName,
  type Page,
  type Searcher,
  type SearchResult,
  type SynonymEdge,
} from './types.js';

export function build(pages: Iterable<Page>, synonyms: SynonymEdge[]): Searcher {
  // 单次遍历页面：建立词表、收集各字段 (termId, pageIdx) 序列
  const vocabList: string[] = [];
  const idOf = new Map<string, number>();
  const intern = (term: string): number => {
    let id = idOf.get(term);
    if (id === undefined) {
      id = vocabList.length;
      vocabList.push(term);
      idOf.set(term, id);
    }
    return id;
  };

  const collectors: Record<FieldName, FieldCollector> = {
    title: new FieldCollector(),
    tags: new FieldCollector(),
    author: new FieldCollector(),
    body: new FieldCollector(),
  };
  const pageIds: number[] = [];
  const seen = new Set<string>();

  for (const page of pages) {
    const pageIdx = pageIds.length;
    pageIds.push(page.id);
    for (const field of FIELD_NAMES) {
      seen.clear();
      for (const token of page[field]) {
        if (seen.has(token)) continue; // 页内字段内去重
        seen.add(token);
        collectors[field].add(intern(token), pageIdx);
      }
    }
  }

  // 同义边端点也加入词表
  for (const edge of synonyms) {
    intern(edge.from);
    intern(edge.to);
  }

  const index: InvertedIndex = buildInvertedIndex(vocabList.length, pageIds, collectors);
  const graph = buildSynonymGraph(vocabList, synonyms);
  const typo = buildTypoIndex(vocabList);

  const pageCount = index.pageCount;
  // 每个查询词元一份页面贡献缓冲（复用，避免逐查询分配）
  const termBest: Int32Array[] = [];
  const touched: number[][] = [];
  for (let i = 0; i < 4; i++) {
    termBest.push(new Int32Array(pageCount));
    touched.push([]);
  }

  const search = (query: string[], k: number): SearchResult[] => {
    if (k <= 0) return [];
    const qterms = [...new Set(query)];
    if (qterms.length === 0 || qterms.length > 4) return [];

    // 先完成全部词元扩展：任一词元无命中则整体无结果（此时评分缓冲尚未写入）
    const expansions: Map<number, number>[] = [];
    for (const q of qterms) {
      const starts = new Map<number, number>();
      const tid = graph.termId(q);
      if (tid !== undefined) starts.set(tid, EXACT_CONFIDENCE);
      for (const ntid of typo.neighbors(q)) {
        starts.set(ntid, TYPO_CONFIDENCE);
      }
      const expanded = graph.expand(starts);
      if (expanded.size === 0) return [];
      expansions.push(expanded);
    }

    // 逐查询词元累计每个页面的最大贡献
    for (let qi = 0; qi < qterms.length; qi++) {
      const expanded = expansions[qi]!;
      const best = termBest[qi]!;
      const tch = touched[qi]!;
      for (const [etid, conf] of expanded) {
        for (const field of FIELD_NAMES) {
          const score = conf * FIELD_WEIGHTS[field];
          const postings = index.postings(field, etid);
          for (let j = 0; j < postings.length; j++) {
            const p = postings[j]!;
            if (best[p] === 0) tch.push(p);
            if (score > best[p]!) best[p] = score;
          }
        }
      }
    }

    // 以命中页面数最少的词元驱动交集，要求每个词元都命中
    let drive = 0;
    for (let qi = 1; qi < qterms.length; qi++) {
      if (touched[qi]!.length < touched[drive]!.length) drive = qi;
    }

    // 容量 k 的最小堆：堆顶为当前第 k 名（分数最低；同分 id 最大）
    const heapScore: number[] = [];
    const heapId: number[] = [];
    const worse = (a: number, b: number): boolean => {
      // a 是否比 b 更差（分数更低，或同分 id 更大）
      if (heapScore[a] !== heapScore[b]) return heapScore[a]! < heapScore[b]!;
      return heapId[a]! > heapId[b]!;
    };
    const siftUp = (i: number): void => {
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!worse(i, parent)) break;
        swap(i, parent);
        i = parent;
      }
    };
    const siftDown = (i: number): void => {
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let worst = i;
        if (l < heapScore.length && worse(l, worst)) worst = l;
        if (r < heapScore.length && worse(r, worst)) worst = r;
        if (worst === i) break;
        swap(i, worst);
        i = worst;
      }
    };
    const swap = (a: number, b: number): void => {
      const ts = heapScore[a]!;
      heapScore[a] = heapScore[b]!;
      heapScore[b] = ts;
      const ti = heapId[a]!;
      heapId[a] = heapId[b]!;
      heapId[b] = ti;
    };
    const offer = (score: number, id: number): void => {
      if (heapScore.length < k) {
        heapScore.push(score);
        heapId.push(id);
        siftUp(heapScore.length - 1);
      } else if (score > heapScore[0]! || (score === heapScore[0]! && id < heapId[0]!)) {
        heapScore[0] = score;
        heapId[0] = id;
        siftDown(0);
      }
    };

    const driveTouched = touched[drive]!;
    for (const p of driveTouched) {
      let total = 0;
      let hitAll = true;
      for (let qi = 0; qi < qterms.length; qi++) {
        const contrib = termBest[qi]![p]!;
        if (contrib === 0) {
          hitAll = false;
          break;
        }
        total += contrib;
      }
      if (hitAll) offer(total, index.pageId(p));
    }

    // 复位贡献缓冲，保持只读索引可复用
    for (let qi = 0; qi < qterms.length; qi++) {
      const best = termBest[qi]!;
      for (const p of touched[qi]!) best[p] = 0;
      touched[qi] = [];
    }

    const out: SearchResult[] = [];
    for (let i = 0; i < heapScore.length; i++) {
      out.push({ id: heapId[i]!, score: heapScore[i]! });
    }
    out.sort((a, b) => b.score - a.score || a.id - b.id);
    return out;
  };

  return { search };
}
