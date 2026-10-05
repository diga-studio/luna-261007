import type { Page, SynonymEdge } from "../src/types.js";

export interface ScaleData {
  /** Lazy page iterator: pages are produced on demand and not retained. */
  pages: Iterable<Page>;
  synonyms: SynonymEdge[];
  /** 50 distinct queries: each = [fuzzy neighbor of the hot word, rare word]. */
  queries: string[][];
  stats: {
    pageCount: number;
    tokenCount: number;
    vocabSize: number;
    edgeCount: number;
    hotWordPages: number;
  };
}

export const HOT_WORD = "commondesk";

/** Deterministic PRNG (mulberry32) so every run reproduces the same data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAGE_COUNT = 100_000;
const TOKENS_PER_PAGE = 80; // 100k * 80 = 8M deduped tokens
const TITLE_COUNT = 5;
const TAGS_COUNT = 10;
const AUTHOR_COUNT = 5;
const BODY_COUNT = TOKENS_PER_PAGE - TITLE_COUNT - TAGS_COUNT - AUTHOR_COUNT;
const VOCAB_SIZE = 30_000;
const EDGE_COUNT = 100_000;
const QUERY_COUNT = 50;
const HOT_PAGE_SHARE = 0.6; // 60% of pages carry the hot word (>= half)
/** Each rare query word is placed in roughly this many (hot) pages. */
const RARE_PAGE_COUNT = 25;

/** Builds the 30k-word vocabulary; all words <= 24 code points. */
function buildVocab(): string[] {
  const vocab: string[] = [HOT_WORD];
  const seen = new Set<string>(vocab);
  const rand = mulberry32(0x5eed);
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  while (vocab.length < VOCAB_SIZE) {
    const len = 4 + Math.floor(rand() * 12); // 4..15 code points
    let w = "";
    for (let i = 0; i < len; i++) {
      w += alphabet[Math.floor(rand() * alphabet.length)];
    }
    if (!seen.has(w)) {
      seen.add(w);
      vocab.push(w);
    }
  }
  return vocab;
}

/**
 * Distance-1 typos of the hot word used as fuzzy query terms.
 * Deliberately absent from the generated vocabulary and edge endpoints.
 */
function hotWordTypos(): string[] {
  const typos = new Set<string>();
  const subs = "qxzvwjky";
  // Deletions, substitutions and insertions at every position give
  // plenty of distinct distance-1 variants.
  for (let pos = 0; pos < HOT_WORD.length && typos.size < QUERY_COUNT; pos++) {
    typos.add(HOT_WORD.slice(0, pos) + HOT_WORD.slice(pos + 1)); // deletion
    for (const c of subs) {
      if (typos.size >= QUERY_COUNT) break;
      if (HOT_WORD[pos] !== c) {
        typos.add(HOT_WORD.slice(0, pos) + c + HOT_WORD.slice(pos + 1)); // substitution
      }
    }
    if (typos.size < QUERY_COUNT) {
      typos.add(HOT_WORD.slice(0, pos) + "q" + HOT_WORD.slice(pos)); // insertion
    }
  }
  return [...typos];
}

/** Deterministic generator for the scale benchmark. */
export function generateScaleData(seed: number): ScaleData {
  const vocab = buildVocab();
  const rand = mulberry32(seed);
  const hotPages = Math.floor(PAGE_COUNT * HOT_PAGE_SHARE);

  // Rare query words live at the tail of the vocab, one per query.
  const rareWords = vocab.slice(VOCAB_SIZE - QUERY_COUNT);
  const queries = hotWordTypos().map((typo, i) => [typo, rareWords[i]!]);

  // Rare word q_i appears in RARE_PAGE_COUNT pages, always inside the hot
  // page range so [typoOfHot, rare] joins are non-empty.
  const rarePageSets: Array<Set<number>> = rareWords.map(() => new Set<number>());
  for (let i = 0; i < QUERY_COUNT; i++) {
    while (rarePageSets[i]!.size < RARE_PAGE_COUNT) {
      rarePageSets[i]!.add(1 + Math.floor(rand() * hotPages));
    }
  }
  const pageRareWords = new Map<number, string[]>();
  for (let i = 0; i < QUERY_COUNT; i++) {
    for (const pid of rarePageSets[i]!) {
      const list = pageRareWords.get(pid) ?? [];
      list.push(rareWords[i]!);
      pageRareWords.set(pid, list);
    }
  }

  // Synonym edges: random directed pairs over the vocab, weights 0..1000,
  // plus one outgoing edge per rare word so expansion reaches further.
  const synonyms: SynonymEdge[] = [];
  for (let i = 0; i < EDGE_COUNT; i++) {
    const from = vocab[Math.floor(rand() * VOCAB_SIZE)]!;
    const to = vocab[Math.floor(rand() * VOCAB_SIZE)]!;
    synonyms.push({ from, to, w: Math.floor(rand() * 1001) });
  }
  for (let i = 0; i < QUERY_COUNT; i++) {
    synonyms.push({ from: rareWords[i]!, to: vocab[(i * 613) % VOCAB_SIZE]!, w: 700 });
  }

  /** Samples `count` distinct vocab words (excluding rare query words). */
  const sampleField = (count: number, forced: string[]): string[] => {
    const out = [...forced];
    const seen = new Set(forced);
    while (out.length < count) {
      const w = vocab[Math.floor(rand() * (VOCAB_SIZE - QUERY_COUNT))]!;
      if (!seen.has(w)) {
        seen.add(w);
        out.push(w);
      }
    }
    return out;
  };

  function* pageIterator(): Generator<Page> {
    for (let id = 1; id <= PAGE_COUNT; id++) {
      const isHot = id <= hotPages;
      const rare = pageRareWords.get(id) ?? [];
      const title = sampleField(TITLE_COUNT, isHot ? [HOT_WORD] : []);
      const tags = sampleField(TAGS_COUNT, []);
      const author = sampleField(AUTHOR_COUNT, []);
      const body = sampleField(BODY_COUNT, rare);
      yield { id, title, tags, author, body };
    }
  }

  return {
    pages: pageIterator(),
    synonyms,
    queries,
    stats: {
      pageCount: PAGE_COUNT,
      tokenCount: PAGE_COUNT * TOKENS_PER_PAGE,
      vocabSize: VOCAB_SIZE,
      edgeCount: synonyms.length,
      hotWordPages: hotPages,
    },
  };
}
