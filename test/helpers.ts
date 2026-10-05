import type { ContentSource } from "../src/index.js";

/** 可手动推进的时钟。 */
export class FakeClock {
  now = 1_000_000;
  advance(ms: number): void {
    this.now += ms;
  }
  readonly clock = (): number => this.now;
}

interface PendingRead {
  release: () => void;
}

/**
 * 可暂停的内容源：blockReads() 之后每次读块都挂起，
 * 直到 releaseAll() 被调用。waitForPending(n) 用于确定性地
 * 等到有 n 个读操作正停在内容源里。
 */
export class ControllableSource implements ContentSource {
  readonly #chunks = new Map<string, Uint8Array[]>();
  readonly #pending: PendingRead[] = [];
  readonly #observers: Array<{ n: number; resolve: () => void }> = [];
  #blocked = false;

  setChunks(documentId: string, chunks: Uint8Array[]): void {
    this.#chunks.set(documentId, chunks.slice());
  }

  blockReads(): void {
    this.#blocked = true;
  }

  unblockReads(): void {
    this.#blocked = false;
  }

  get pendingReads(): number {
    return this.#pending.length;
  }

  waitForPending(n: number): Promise<void> {
    if (this.#pending.length >= n) return Promise.resolve();
    return new Promise((resolve) => {
      this.#observers.push({ n, resolve });
    });
  }

  releaseAll(): void {
    const batch = this.#pending.splice(0);
    for (const p of batch) p.release();
  }

  #acquire(): Promise<void> {
    if (!this.#blocked) return Promise.resolve();
    return new Promise((resolve) => {
      this.#pending.push({ release: resolve });
      const ready = this.#observers.filter((o) => o.n <= this.#pending.length);
      this.#observers.splice(0, this.#observers.length, ...this.#observers.filter((o) => o.n > this.#pending.length));
      for (const o of ready) o.resolve();
    });
  }

  open(documentId: string): AsyncIterable<Uint8Array> {
    const chunks = this.#chunks.get(documentId);
    if (!chunks) throw new Error(`no chunks registered for ${documentId}`);
    const acquire = () => this.#acquire();
    return (async function* () {
      for (const chunk of chunks) {
        await acquire();
        yield chunk;
      }
    })();
  }
}

export function bytes(...parts: number[]): Uint8Array {
  return Uint8Array.from(parts);
}

export function collectStrings(...sizes: number[]): Uint8Array[] {
  return sizes.map((size, i) => {
    const chunk = new Uint8Array(size);
    chunk.fill((i + 1) & 0xff);
    return chunk;
  });
}
