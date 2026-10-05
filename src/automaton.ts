/**
 * Aho-Corasick 自动机：对归一化后的词集合做多模式连续子串匹配。
 * 词之间允许包含、重叠、同起点，全部命中都会报告。
 *
 * 每个模式在一次 scan 中最多报告一次（最早终点 = 最早起点）；
 * 已报告的模式通过字典序后缀链路径压缩跳过，避免在长重复文本上退化。
 */
export class Automaton {
  private readonly next: Array<Map<number, number>> = [new Map()];
  private readonly fail: number[] = [0];
  private readonly dict: number[] = [0];
  private readonly own: number[][] = [[]];
  private readonly patternLen: number[] = [];

  /** 用归一化后的词构建自动机；patterns 必须非空且已去重。 */
  constructor(patterns: readonly string[]) {
    for (let p = 0; p < patterns.length; p++) {
      const word = patterns[p]!;
      let state = 0;
      for (const ch of word) {
        const cp = ch.codePointAt(0)!;
        let to = this.next[state]!.get(cp);
        if (to === undefined) {
          to = this.next.length;
          this.next.push(new Map());
          this.fail.push(0);
          this.dict.push(0);
          this.own.push([]);
          this.next[state]!.set(cp, to);
        }
        state = to;
      }
      this.own[state]!.push(p);
      this.patternLen.push([...word].length);
    }
    this.buildFailureLinks();
    // BFS 顺序下 fail 已就绪，计算字典序后缀链（最近的有输出祖先）。
    const order: number[] = [0];
    for (let head = 0; head < order.length; head++) {
      const v = order[head]!;
      for (const to of this.next[v]!.values()) {
        order.push(to);
        const f = this.fail[to]!;
        this.dict[to] = this.own[f]!.length > 0 ? f : this.dict[f]!;
      }
    }
  }

  private buildFailureLinks(): void {
    const queue: number[] = [];
    for (const to of this.next[0]!.values()) {
      this.fail[to] = 0;
      queue.push(to);
    }
    for (let head = 0; head < queue.length; head++) {
      const v = queue[head]!;
      for (const [cp, to] of this.next[v]!) {
        queue.push(to);
        let f = this.fail[v]!;
        while (f !== 0 && !this.next[f]!.has(cp)) {
          f = this.fail[f]!;
        }
        const candidate = this.next[f]!.get(cp);
        this.fail[to] = candidate !== undefined && candidate !== to ? candidate : 0;
      }
    }
  }

  /**
   * 扫描归一化文本（字符串或码点流），对每个模式下标回调其最早命中
   * （start/end 为归一化码点下标，左闭右开）。
   * 每个模式在一次扫描中最多回调一次。
   */
  scan(
    input: string | Iterable<number>,
    onMatch: (patternIndex: number, start: number, end: number) => void,
  ): void {
    const nodeCount = this.next.length;
    const cleared = new Uint8Array(nodeCount);
    const jump = Int32Array.from(this.dict);
    const recorded = new Uint8Array(this.patternLen.length);
    let state = 0;
    let i = 0;
    const step = (cp: number): void => {
      while (state !== 0 && !this.next[state]!.has(cp)) {
        state = this.fail[state]!;
      }
      state = this.next[state]!.get(cp) ?? 0;
      i++;
      let v = state;
      while (v !== 0) {
        if (cleared[v] === 0) {
          cleared[v] = 1;
          for (const p of this.own[v]!) {
            if (recorded[p] === 0) {
              recorded[p] = 1;
              onMatch(p, i - this.patternLen[p]!, i);
            }
          }
        }
        const nv = jump[v]!;
        jump[v] = nv !== 0 && cleared[nv] !== 0 ? jump[nv]! : nv;
        v = jump[v]!;
      }
    };
    if (typeof input === "string") {
      for (const ch of input) {
        step(ch.codePointAt(0)!);
      }
    } else {
      for (const cp of input) {
        step(cp);
      }
    }
  }
}
