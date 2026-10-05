import { CorrectionIndex } from "./correction.js";
import { TopKHeap } from "./heap.js";
import { FIELD_WEIGHT, type Hit, type Page, type Retriever, type SynonymEdge } from "./types.js";

export type { Hit, Page, Retriever, SynonymEdge } from "./types.js";

const NUM_FIELDS = 4;

/** maxFieldWeight[mask] = highest field weight present in the 4-bit mask. */
const MAX_FIELD_WEIGHT = new Uint8Array(1 << NUM_FIELDS);
for (let mask = 1; mask < MAX_FIELD_WEIGHT.length; mask++) {
  let best = 0;
  for (let f = 0; f < NUM_FIELDS; f++) {
    if (mask & (1 << f)) best = Math.max(best, FIELD_WEIGHT[f]!);
  }
  MAX_FIELD_WEIGHT[mask] = best;
}

const START_CONFIDENCE = 1000;
const CORRECTION_CONFIDENCE = 600;

class ScribeDeskRetriever implements Retriever {
  /** word -> wordId */
  private readonly wordIds = new Map<string, number>();
  private readonly vocab: string[] = [];

  /** external page id -> dense index, and back. */
  private readonly pageDense = new Map<number, number>();
  private readonly pageIds: number[] = [];

  /** Build-time posting triples (wordId, densePage, mask), grown by doubling. */
  private tWord = new Uint32Array(1 << 16);
  private tPage = new Uint32Array(1 << 16);
  private tMask = new Uint8Array(1 << 16);
  private tLen = 0;

  /** Final postings CSR over dense page indexes. */
  private postingStart: Uint32Array = new Uint32Array(0);
  private postingPage: Uint32Array = new Uint32Array(0);
  private postingMask: Uint8Array = new Uint8Array(0);

  /** Build-time edge triples. */
  private eFrom: number[] = [];
  private eTo: number[] = [];
  private eW: number[] = [];

  /** Final synonym graph CSR over wordIds. */
  private edgeStart: Uint32Array = new Uint32Array(0);
  private edgeTo: Uint32Array = new Uint32Array(0);
  private edgeW = new Uint32Array(0);

  private correction: CorrectionIndex | null = null;

  // ---- search scratch buffers (reused across queries; no result caching) ----
  private expConf = new Int32Array(0); // wordId -> best confidence this expansion
  private expStamp = new Uint32Array(0);
  private expList: number[] = []; // wordIds touched by current expansion
  private heapConf = new Int32Array(1024);
  private heapWord = new Int32Array(1024);
  private termScore = new Int32Array(0); // [termSlot * pageCount + dense]
  private termStamp = new Uint32Array(0);
  private expStampCounter = 0;
  private termStampCounter = 0;

  private wordId(word: string): number {
    let id = this.wordIds.get(word);
    if (id === undefined) {
      id = this.vocab.length;
      this.wordIds.set(word, id);
      this.vocab.push(word);
    }
    return id;
  }

  private pushTriple(word: number, page: number, mask: number): void {
    if (this.tLen === this.tWord.length) {
      const cap = this.tWord.length * 2;
      const nw = new Uint32Array(cap);
      nw.set(this.tWord);
      this.tWord = nw;
      const np = new Uint32Array(cap);
      np.set(this.tPage);
      this.tPage = np;
      const nm = new Uint8Array(cap);
      nm.set(this.tMask);
      this.tMask = nm;
    }
    this.tWord[this.tLen] = word;
    this.tPage[this.tLen] = page;
    this.tMask[this.tLen] = mask;
    this.tLen++;
  }

  addPage(page: Page): void {
    let dense = this.pageDense.get(page.id);
    if (dense === undefined) {
      dense = this.pageIds.length;
      this.pageDense.set(page.id, dense);
      this.pageIds.push(page.id);
    }
    const fields = [page.title, page.tags, page.author, page.body];
    for (let f = 0; f < NUM_FIELDS; f++) {
      const seen = new Set<string>();
      for (const token of fields[f]!) {
        if (seen.has(token)) continue;
        seen.add(token);
        this.pushTriple(this.wordId(token), dense, 1 << f);
      }
    }
  }

  addEdge(edge: SynonymEdge): void {
    this.eFrom.push(this.wordId(edge.from));
    this.eTo.push(this.wordId(edge.to));
    this.eW.push(edge.w);
  }

  /**
   * Compacts posting triples into CSR ordered by wordId (counting sort,
   * stable), merging duplicate (word, page) entries from different fields
   * into one mask. Duplicates are adjacent: a page's fields are appended
   * consecutively and the sort is stable.
   */
  private finishPostings(): void {
    const n = this.vocab.length;
    const starts = new Uint32Array(n + 1);
    for (let i = 0; i < this.tLen; i++) {
      starts[this.tWord[i]! + 1]!++;
    }
    for (let i = 0; i < n; i++) {
      starts[i + 1] = starts[i + 1]! + starts[i]!;
    }
    const total = this.tLen;
    let page = new Uint32Array(total);
    let mask = new Uint8Array(total);
    const cursor = starts.slice(0, n);
    for (let i = 0; i < total; i++) {
      const w = this.tWord[i]!;
      const pos = cursor[w]!;
      cursor[w] = pos + 1;
      page[pos] = this.tPage[i]!;
      mask[pos] = this.tMask[i]!;
    }
    // Free triples before further allocations.
    this.tWord = new Uint32Array(0);
    this.tPage = new Uint32Array(0);
    this.tMask = new Uint8Array(0);
    this.tLen = 0;
    // Merge adjacent duplicates (same word, same page) in place.
    let write = 0;
    const mergedStarts = new Uint32Array(n + 1);
    for (let w = 0; w < n; w++) {
      mergedStarts[w] = write;
      const end = starts[w + 1]!;
      let read = starts[w]!;
      while (read < end) {
        const p = page[read]!;
        let m = mask[read]!;
        read++;
        while (read < end && page[read] === p) {
          m |= mask[read]!;
          read++;
        }
        page[write] = p;
        mask[write] = m;
        write++;
      }
    }
    mergedStarts[n] = write;
    this.postingStart = mergedStarts;
    this.postingPage = page.subarray(0, write);
    this.postingMask = mask.subarray(0, write);
  }

  private finishEdges(): void {
    const n = this.vocab.length;
    const starts = new Uint32Array(n + 1);
    const m = this.eFrom.length;
    for (let i = 0; i < m; i++) {
      starts[this.eFrom[i]! + 1]!++;
    }
    for (let i = 0; i < n; i++) {
      starts[i + 1] = starts[i + 1]! + starts[i]!;
    }
    const to = new Uint32Array(m);
    const weight = new Uint32Array(m);
    const cursor = starts.slice(0, n);
    for (let i = 0; i < m; i++) {
      const f = this.eFrom[i]!;
      const pos = cursor[f]!;
      cursor[f] = pos + 1;
      to[pos] = this.eTo[i]!;
      weight[pos] = this.eW[i]!;
    }
    this.eFrom = [];
    this.eTo = [];
    this.eW = [];
    this.edgeStart = starts;
    this.edgeTo = to;
    this.edgeW = weight;
  }

  finish(): void {
    this.finishPostings();
    this.finishEdges();
    this.correction = new CorrectionIndex(this.vocab);
    // Search scratch buffers.
    const words = this.vocab.length;
    this.expConf = new Int32Array(words);
    this.expStamp = new Uint32Array(words);
    const pages = this.pageIds.length;
    this.termScore = new Int32Array(4 * pages);
    this.termStamp = new Uint32Array(4 * pages);
  }

  // ---- max-heap over (confidence, wordId) ----
  private heapLen = 0;

  private heapPush(conf: number, word: number): void {
    if (this.heapLen === this.heapConf.length) {
      const cap = this.heapConf.length * 2;
      const nc = new Int32Array(cap);
      nc.set(this.heapConf.subarray(0, this.heapLen));
      this.heapConf = nc;
      const nw = new Int32Array(cap);
      nw.set(this.heapWord.subarray(0, this.heapLen));
      this.heapWord = nw;
    }
    let i = this.heapLen++;
    this.heapConf[i] = conf;
    this.heapWord[i] = word;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heapConf[parent]! >= this.heapConf[i]!) break;
      this.heapSwap(i, parent);
      i = parent;
    }
  }

  private heapSwap(a: number, b: number): void {
    const tc = this.heapConf[a]!;
    this.heapConf[a] = this.heapConf[b]!;
    this.heapConf[b] = tc;
    const tw = this.heapWord[a]!;
    this.heapWord[a] = this.heapWord[b]!;
    this.heapWord[b] = tw;
  }

  private heapPop(): void {
    const last = --this.heapLen;
    this.heapSwap(0, last);
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let largest = i;
      if (left < this.heapLen && this.heapConf[left]! > this.heapConf[largest]!) largest = left;
      if (right < this.heapLen && this.heapConf[right]! > this.heapConf[largest]!) largest = right;
      if (largest === i) break;
      this.heapSwap(i, largest);
      i = largest;
    }
  }

  /**
   * Best-first synonym expansion from the given starts. Confidence after
   * an edge: floor(conf * w / 1000) — never increases, so a word popped
   * from the max-heap is settled at its maximum confidence. Zero
   * confidence is neither stored nor propagated. Fills expConf/expList.
   */
  private expand(starts: Array<readonly [number, number]>): void {
    this.expStampCounter++;
    const s = this.expStampCounter;
    this.expList = [];
    this.heapLen = 0;
    for (const [word, conf] of starts) {
      if (conf <= 0) continue;
      if (this.expStamp[word] !== s || this.expConf[word]! < conf) {
        this.expStamp[word] = s;
        this.expConf[word] = conf;
        this.expList.push(word);
        this.heapPush(conf, word);
      }
    }
    while (this.heapLen > 0) {
      const conf = this.heapConf[0]!;
      const word = this.heapWord[0]!;
      this.heapPop();
      if (this.expStamp[word] === s && conf < this.expConf[word]!) continue; // stale
      const begin = this.edgeStart[word]!;
      const end = this.edgeStart[word + 1]!;
      for (let e = begin; e < end; e++) {
        const next = Math.floor((conf * this.edgeW[e]!) / 1000);
        if (next <= 0) continue;
        const target = this.edgeTo[e]!;
        if (this.expStamp[target] !== s || this.expConf[target]! < next) {
          if (this.expStamp[target] !== s) this.expList.push(target);
          this.expStamp[target] = s;
          this.expConf[target] = next;
          this.heapPush(next, target);
        }
      }
    }
  }

  /**
   * Scores every page hit by the expansion of one query term into
   * termScore/termStamp at the given slot. Returns touched dense pages.
   */
  private scoreTerm(term: string, slot: number): number[] {
    const starts: Array<readonly [number, number]> = [];
    const wid = this.wordIds.get(term);
    if (wid !== undefined) starts.push([wid, START_CONFIDENCE]);
    for (const neighbor of this.correction!.neighbors(term)) {
      starts.push([this.wordIds.get(neighbor)!, CORRECTION_CONFIDENCE]);
    }
    this.expand(starts);
    this.termStampCounter++;
    const s = this.termStampCounter;
    const pages = this.pageIds.length;
    const base = slot * pages;
    const touched: number[] = [];
    for (const word of this.expList) {
      const conf = this.expConf[word]!;
      const begin = this.postingStart[word]!;
      const end = this.postingStart[word + 1]!;
      for (let p = begin; p < end; p++) {
        const contribution = conf * MAX_FIELD_WEIGHT[this.postingMask[p]!]!;
        const d = this.postingPage[p]!;
        const idx = base + d;
        if (this.termStamp[idx] !== s) {
          this.termStamp[idx] = s;
          this.termScore[idx] = contribution;
          touched.push(d);
        } else if (contribution > this.termScore[idx]!) {
          this.termScore[idx] = contribution;
        }
      }
    }
    return touched;
  }

  search(query: string[], k: number): Hit[] {
    const terms = [...new Set(query)];
    if (terms.length === 0 || k <= 0) return [];
    const pages = this.pageIds.length;
    // Spec allows 1..4 terms; grow scratch if a caller passes more.
    if (terms.length * pages > this.termScore.length) {
      this.termScore = new Int32Array(terms.length * pages);
      this.termStamp = new Uint32Array(terms.length * pages);
      this.termStampCounter = 0;
    }
    const perTerm: number[][] = [];
    for (let t = 0; t < terms.length; t++) {
      perTerm.push(this.scoreTerm(terms[t]!, t));
    }
    // Intersect from the smallest candidate set; pages must hit all terms.
    // scoreTerm stamps slot t of this query with termStampCounter-(T-1-t).
    const order = perTerm
      .map((list, i) => [list.length, i] as const)
      .sort((a, b) => a[0] - b[0]);
    const heap = new TopKHeap(k);
    const termCount = terms.length;
    const smallest = perTerm[order[0]![1]]!;
    for (const d of smallest) {
      let total = 0;
      let hitAll = true;
      for (let t = 0; t < termCount; t++) {
        const idx = t * pages + d;
        const validStamp = this.termStampCounter - (termCount - 1 - t);
        if (this.termStamp[idx] !== validStamp) {
          hitAll = false;
          break;
        }
        total += this.termScore[idx]!;
      }
      if (hitAll) heap.offer(this.pageIds[d]!, total);
    }
    return heap.sorted();
  }
}

/**
 * Builds the read-only retrieval structure. `pages` is consumed once;
 * the result does not retain references to the page objects.
 */
export function build(
  pages: Iterable<Page>,
  synonyms: Iterable<SynonymEdge>,
): Retriever {
  const r = new ScribeDeskRetriever();
  for (const page of pages) {
    r.addPage(page);
  }
  for (const edge of synonyms) {
    r.addEdge(edge);
  }
  r.finish();
  return r;
}
