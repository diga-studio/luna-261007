import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';
import type {
  DataVersion,
  QueryResult,
  RecommendationComputer,
  UserId,
} from './types.js';

export interface RecommendationCacheOptions<TItem> {
  /** 上层提供的本地异步推荐计算器 */
  compute: RecommendationComputer<TItem>;
  /** 初始数据版本，默认为 0 */
  initialVersion?: DataVersion;
  /** 新鲜缓存时长，默认 600000ms */
  freshTtlMs?: number;
  /** 每次未命中查询的等待预算，默认 5000ms */
  waitBudgetMs?: number;
  /** 时钟，默认系统时钟 */
  clock?: Clock;
}

interface CacheEntry<TItem> {
  version: DataVersion;
  items: TItem[];
  /** 成功计算完成的时间点，从此开始计新鲜期 */
  completedAt: number;
}

interface Inflight<TItem> {
  version: DataVersion;
  promise: Promise<TItem[]>;
}

type WaitOutcome<TItem> =
  | { type: 'ok'; items: TItem[] }
  | { type: 'fail' }
  | { type: 'timeout' }
  | { type: 'version-changed' };

const DEFAULT_FRESH_TTL_MS = 600_000;
const DEFAULT_WAIT_BUDGET_MS = 5_000;

/**
 * 推荐缓存模块：缓存与运行状态只存内存。
 * - 缓存按用户隔离，并属于一个数据版本；
 * - 同一用户、同一版本同时最多一次未完成计算；
 * - 每次未命中查询有独立的等待预算，超时/失败降级为陈旧缓存或暂不可用；
 * - 版本只递增，切换后旧缓存失效，等待中的查询在剩余预算内改等新版本。
 */
export class RecommendationCache<TItem> {
  private readonly compute: RecommendationComputer<TItem>;
  private readonly freshTtlMs: number;
  private readonly waitBudgetMs: number;
  private readonly clock: Clock;

  private version: DataVersion;
  private readonly cache = new Map<UserId, CacheEntry<TItem>>();
  private readonly inflight = new Map<UserId, Inflight<TItem>>();
  private versionWaiters: Array<() => void> = [];

  constructor(options: RecommendationCacheOptions<TItem>) {
    this.compute = options.compute;
    this.freshTtlMs = options.freshTtlMs ?? DEFAULT_FRESH_TTL_MS;
    this.waitBudgetMs = options.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS;
    this.clock = options.clock ?? new SystemClock();
    this.version = options.initialVersion ?? 0;
  }

  /** 当前数据版本 */
  getVersion(): DataVersion {
    return this.version;
  }

  /** 切换全局数据版本（只递增）。切换后旧缓存失效，等待中的查询改等新版本，原截止点不变。 */
  setVersion(version: DataVersion): void {
    if (version <= this.version) {
      throw new Error(
        `data version must increase: current=${this.version}, got=${version}`,
      );
    }
    this.version = version;
    const waiters = this.versionWaiters;
    this.versionWaiters = [];
    for (const notify of waiters) notify();
  }

  /** 按用户查询推荐 */
  query(userId: UserId): Promise<QueryResult<TItem>> {
    // 截止点从进入模块起算，之后不因任何事件（包括版本切换）改变
    const deadline = this.clock.now() + this.waitBudgetMs;
    return this.queryLoop(userId, deadline);
  }

  private async queryLoop(
    userId: UserId,
    deadline: number,
  ): Promise<QueryResult<TItem>> {
    for (;;) {
      const now = this.clock.now();
      const fresh = this.readFresh(userId, now);
      if (fresh) return { status: 'fresh', items: fresh.items };

      const remaining = deadline - now;
      if (remaining <= 0) return this.degrade(userId);

      const record = this.ensureInflight(userId, this.version);
      const outcome = await this.waitOutcome(record, remaining);

      if (outcome.type === 'version-changed') continue; // 剩余预算内改等新版本
      if (outcome.type === 'timeout') return this.degrade(userId);
      if (record.version !== this.version) continue; // 旧版本计算的迟到结果，忽略
      if (outcome.type === 'ok') return { status: 'computed', items: outcome.items };
      return this.degrade(userId); // 当前版本计算失败
    }
  }

  /** 计算失败或预算耗尽时的降级：当前版本的陈旧缓存，否则暂不可用 */
  private degrade(userId: UserId): QueryResult<TItem> {
    const entry = this.cache.get(userId);
    if (!entry || entry.version !== this.version) {
      return { status: 'unavailable' };
    }
    if (this.clock.now() - entry.completedAt < this.freshTtlMs) {
      return { status: 'fresh', items: entry.items };
    }
    return { status: 'stale', items: entry.items };
  }

  private readFresh(userId: UserId, now: number): CacheEntry<TItem> | null {
    const entry = this.cache.get(userId);
    if (!entry || entry.version !== this.version) return null;
    if (now - entry.completedAt >= this.freshTtlMs) return null;
    return entry;
  }

  /** 取得或发起 (用户, 当前版本) 的计算；旧版本的未完成计算不阻塞新版本 */
  private ensureInflight(userId: UserId, version: DataVersion): Inflight<TItem> {
    const existing = this.inflight.get(userId);
    if (existing && existing.version === version) return existing;

    const record: Inflight<TItem> = {
      version,
      promise: Promise.resolve().then(() => this.compute(userId, version)),
    };
    this.inflight.set(userId, record);

    record.promise.then(
      (items) => {
        if (this.inflight.get(userId) === record) this.inflight.delete(userId);
        // 迟到成功只能更新同版本缓存；旧版本结果不得覆盖新缓存
        if (record.version === this.version) {
          this.cache.set(userId, {
            version: record.version,
            items,
            completedAt: this.clock.now(),
          });
        }
      },
      () => {
        // 失败不清缓存；仅释放 inflight 让后续查询可重新发起
        if (this.inflight.get(userId) === record) this.inflight.delete(userId);
      },
    );
    return record;
  }

  private waitOutcome(
    record: Inflight<TItem>,
    remainingMs: number,
  ): Promise<WaitOutcome<TItem>> {
    return new Promise<WaitOutcome<TItem>>((resolve) => {
      let settled = false;
      const onVersionChanged = (): void => finish({ type: 'version-changed' });
      const finish = (outcome: WaitOutcome<TItem>): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        const idx = this.versionWaiters.indexOf(onVersionChanged);
        if (idx >= 0) this.versionWaiters.splice(idx, 1);
        resolve(outcome);
      };
      const timer = this.clock.setTimeout(() => {
        finish({ type: 'timeout' });
      }, remainingMs);

      record.promise.then(
        (items) => finish({ type: 'ok', items }),
        () => finish({ type: 'fail' }),
      );
      this.versionWaiters.push(onVersionChanged);
    });
  }
}
