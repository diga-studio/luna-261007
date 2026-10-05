import type { ContentSource } from '../src/index.js';

/** 手动时钟：测试通过修改 now 推进时间。 */
export class ManualClock {
  now: number;
  constructor(start = 1_000_000) {
    this.now = start;
  }
  fn(): number {
    return this.now;
  }
}

export function textChunks(...parts: string[]): Uint8Array[] {
  return parts.map((p) => new TextEncoder().encode(p));
}

export async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const chunk of stream) {
    out.push(chunk);
  }
  return out;
}

export function decode(chunks: Uint8Array[]): string {
  return new TextDecoder().decode(
    Uint8Array.from(chunks.flatMap((c) => Array.from(c))),
  );
}

/**
 * 可暂停内容源：pause() 后，所有进入读取的 next() 挂起；
 * resume() 一次性放行全部挂起的读取。pendingCount 精确反映
 * 正在等待内容源的读取数，供测试确定性同步。
 */
export class PausableSource implements ContentSource {
  private readonly chunks: Uint8Array[];
  private paused = false;
  private waiters: Array<() => void> = [];
  private pending = 0;
  private pendingWatchers: Array<{ n: number; resolve: () => void }> = [];

  constructor(chunks: Uint8Array[]) {
    this.chunks = chunks;
  }

  get pendingCount(): number {
    return this.pending;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /** 等待直到有 n 个读取正挂在内容源上。 */
  waitForPending(n: number): Promise<void> {
    if (this.pending >= n) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.pendingWatchers.push({ n, resolve });
    });
  }

  private bumpPending(): void {
    const watchers = this.pendingWatchers.splice(0);
    for (const w of watchers) {
      if (this.pending >= w.n) {
        w.resolve();
      } else {
        this.pendingWatchers.push(w);
      }
    }
  }

  open(_documentId: string): AsyncIterable<Uint8Array> {
    const chunks = this.chunks;
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next(): Promise<IteratorResult<Uint8Array>> {
            self.pending += 1;
            self.bumpPending();
            try {
              if (self.paused) {
                await new Promise<void>((resolve) => {
                  self.waiters.push(resolve);
                });
              }
              if (index >= chunks.length) {
                return { done: true, value: undefined };
              }
              const chunk = chunks[index]!;
              index += 1;
              return { done: false, value: chunk };
            } finally {
              self.pending -= 1;
            }
          },
        };
      },
    };
  }
}
