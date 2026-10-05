import type { Clock } from '../src/index.js';
import type { DataVersion, UserId } from '../src/index.js';

interface Timer {
  id: number;
  at: number;
  callback: () => void;
}

/** 手动推进的假时钟：setTimeout 只在 advance() 时触发 */
export class FakeClock implements Clock {
  private current = 0;
  private timers: Timer[] = [];
  private nextId = 1;

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.push({ id, at: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }

  /** 推进时间并触发到期定时器（定时器回调里新挂的定时器若也在窗口内会一并触发） */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers) {
        if (t.at <= target && (!next || t.at < next.at)) next = t;
      }
      if (!next) break;
      this.current = next.at;
      this.timers = this.timers.filter((t) => t !== next);
      next.callback();
    }
    this.current = target;
  }
}

export interface ComputeCall {
  userId: UserId;
  version: DataVersion;
  resolve: (items: string[]) => void;
  reject: (err: unknown) => void;
}

/**
 * 可控推荐计算器：每次计算调用都挂起，由测试显式 resolve/reject。
 * 推荐内容形如 `u1@v3#1`，能明确辨认用户和数据版本。
 */
export class TestComputer {
  readonly calls: ComputeCall[] = [];

  readonly compute = (userId: UserId, version: DataVersion): Promise<string[]> =>
    new Promise<string[]>((resolve, reject) => {
      this.calls.push({ userId, version, resolve, reject });
    });

  get count(): number {
    return this.calls.length;
  }

  last(): ComputeCall {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error('no compute call yet');
    return call;
  }
}

/** 让已排队的微任务（promise 链）跑完 */
export async function flush(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 推进假时钟并等待微任务结算 */
export async function advanceAndFlush(clock: FakeClock, ms: number): Promise<void> {
  clock.advance(ms);
  await flush();
}

/** 生成可辨认用户与数据版本的推荐内容 */
export function items(userId: UserId, version: DataVersion): string[] {
  return [`${userId}@v${version}#1`, `${userId}@v${version}#2`];
}
