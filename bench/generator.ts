import type { Page, SynonymEdge } from '../src/index.js';

/** 确定性 PRNG，保证生成器可重复。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BENCH_SCALE = {
  pageCount: 100_000,
  vocabSize: 30_000,
  edgeCount: 100_000,
  tokensPerPage: { title: 3, tags: 5, author: 2, body: 70 },
  commonWord: 'scribeword',
  commonWordPageShare: 0.6,
} as const;

export interface BenchData {
  vocab: string[];
  pages: Iterable<Page>;
  synonyms: SynonymEdge[];
  /** 50 个查询：高频词的模糊近邻 + 稀有词 */
  queries: string[][];
  stats: {
    totalTokens: number;
    pagesWithCommonWord: number;
  };
}

/** 生成 30000 个词：小写字母为主，每隔若干词嵌入非 BMP 字符。 */
export function generateVocab(seed: number, size: number): string[] {
  const rand = mulberry32(seed);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const emoji = ['😀', '🚀', '🎉', '🌟', '🍀'];
  const seen = new Set<string>();
  const vocab: string[] = [];
  while (vocab.length < size) {
    const len = 3 + Math.floor(rand() * 10); // 3..12 码点
    let w = '';
    for (let i = 0; i < len; i++) w += letters[Math.floor(rand() * 26)];
    if (vocab.length % 997 === 0) {
      const pos = Math.floor(rand() * w.length);
      w = w.slice(0, pos) + emoji[Math.floor(rand() * emoji.length)] + w.slice(pos);
    }
    if (w === BENCH_SCALE.commonWord || seen.has(w)) continue;
    seen.add(w);
    vocab.push(w);
  }
  return vocab;
}

/** 对词做一次编辑距离恰为 1 的确定性扰动（替换/插入/删除轮换）。 */
export function typoVariant(word: string, rand: () => number, kind: number): string {
  const cps = Array.from(word);
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const pos = Math.floor(rand() * cps.length);
  if (kind % 3 === 0) {
    // 替换
    let ch = letters[Math.floor(rand() * 26)]!;
    while (ch === cps[pos]) ch = letters[Math.floor(rand() * 26)]!;
    cps[pos] = ch;
  } else if (kind % 3 === 1) {
    // 插入
    cps.splice(pos, 0, letters[Math.floor(rand() * 26)]!);
  } else {
    // 删除
    cps.splice(pos, 1);
  }
  return cps.join('');
}

export function generateBenchData(seed = 20261006): BenchData {
  const scale = BENCH_SCALE;
  const rand = mulberry32(seed);
  const vocab = generateVocab(seed, scale.vocabSize);
  const common = scale.commonWord;

  // Zipf 词频：rank 越小越常见；vocab[0] 留给高频词
  const words = [common, ...vocab];
  const zipfCum = new Float64Array(words.length);
  let acc = 0;
  for (let i = 0; i < words.length; i++) {
    acc += 1 / (i + 1);
    zipfCum[i] = acc;
  }
  const zipfTotal = acc;
  const sampleWord = (): string => {
    const x = rand() * zipfTotal;
    let lo = 0;
    let hi = words.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (zipfCum[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return words[lo]!;
  };

  // 同义边：随机有向边，权重 0..1000
  const synonyms: SynonymEdge[] = [];
  for (let i = 0; i < scale.edgeCount; i++) {
    synonyms.push({
      from: words[Math.floor(rand() * words.length)]!,
      to: words[Math.floor(rand() * words.length)]!,
      w: Math.floor(rand() * 1001),
    });
  }

  const perPage = scale.tokensPerPage;
  const tokensPerPageTotal = perPage.title + perPage.tags + perPage.author + perPage.body;
  let pagesWithCommon = 0;

  const fieldSample = (count: number, forceCommon: boolean): string[] => {
    const out = new Set<string>();
    if (forceCommon && count > 0) out.add(common);
    while (out.size < count) out.add(sampleWord());
    return [...out];
  };

  const commonPages = scale.pageCount * scale.commonWordPageShare;
  let pageIdx = 0;
  const pages: Iterable<Page> = {
    *[Symbol.iterator]() {
      for (let i = 0; i < scale.pageCount; i++) {
        const forceCommon = i < commonPages; // 前 60% 页面必含高频词
        if (forceCommon) pagesWithCommon++;
        yield {
          id: 1_000_000 + i,
          title: fieldSample(perPage.title, false),
          body: fieldSample(perPage.body, forceCommon),
          tags: fieldSample(perPage.tags, false),
          author: fieldSample(perPage.author, false),
        };
        pageIdx = i;
      }
    },
  };

  // 50 个查询：高频词的模糊近邻（替换/插入/删除轮换）+ 稀有词（词表尾部）
  const queries: string[][] = [];
  const vocabSet = new Set(words);
  for (let i = 0; i < 50; i++) {
    let variant = typoVariant(common, rand, i);
    while (vocabSet.has(variant)) variant = typoVariant(common, rand, i + 1);
    const rare = words[words.length - 1 - (i % 500)]!;
    queries.push([variant, rare]);
  }

  return {
    vocab: words,
    pages,
    synonyms,
    queries,
    stats: {
      totalTokens: scale.pageCount * tokensPerPageTotal,
      get pagesWithCommonWord() {
        return pagesWithCommon;
      },
    },
  };
}
