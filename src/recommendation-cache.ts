import type {
  QueryResult,
  RecommendationComputer,
  RecommendationCacheOptions,
  RecommendationList,
} from "./types.js";

interface CacheEntry {
  version: number;
  items: RecommendationList;
  completedAt: number;
}

type SettleListener = (succeeded: boolean) => void;

/** One in-flight computation for a specific user and data version. */
interface Computation {
  version: number;
  listeners: Set<SettleListener>;
}

type WaitOutcome = "success" | "failure" | "timeout" | "version-changed";

const DEFAULT_BUDGET_MS = 5_000;
const DEFAULT_FRESH_MS = 600_000;

export class RecommendationCache {
  private readonly compute: RecommendationComputer;
  private readonly budgetMs: number;
  private readonly freshMs: number;
  private version: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Computation>();
  private readonly versionListeners = new Set<() => void>();

  constructor(options: RecommendationCacheOptions) {
    this.compute = options.compute;
    this.budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    this.version = options.initialVersion ?? 0;
  }

  /** Query recommendations for a user against the current data version. */
  async getRecommendations(userId: string): Promise<QueryResult> {
    const deadline = Date.now() + this.budgetMs;
    for (;;) {
      const version = this.version;
      const entry = this.cache.get(userId);
      if (
        entry &&
        entry.version === version &&
        Date.now() - entry.completedAt < this.freshMs
      ) {
        return { kind: "fresh", userId, version, items: entry.items };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return this.fallback(userId);
      }
      const computation = this.ensureComputation(userId, version);
      const outcome = await this.waitFor(computation, remaining);
      if (this.version !== version) {
        // The data version moved on: keep trying the new version
        // within what is left of the original budget.
        continue;
      }
      if (outcome === "success") {
        const done = this.cache.get(userId);
        if (done && done.version === version) {
          return { kind: "fresh", userId, version, items: done.items };
        }
        continue;
      }
      // "failure" or "timeout": degrade to stale cache or report unavailable.
      return this.fallback(userId);
    }
  }

  /**
   * Switch the global data version. Versions only increase.
   * Old caches become invalid immediately; pending queries keep their
   * original deadlines and move on to the new version.
   */
  switchVersion(newVersion: number): void {
    if (newVersion <= this.version) {
      throw new Error(
        `version must increase: current ${this.version}, got ${newVersion}`
      );
    }
    this.version = newVersion;
    this.cache.clear();
    this.inflight.clear();
    for (const listener of [...this.versionListeners]) {
      listener();
    }
  }

  /** Current global data version. */
  get currentVersion(): number {
    return this.version;
  }

  private fallback(userId: string): QueryResult {
    const entry = this.cache.get(userId);
    if (entry && entry.version === this.version) {
      return { kind: "stale", userId, version: entry.version, items: entry.items };
    }
    return { kind: "unavailable", userId, version: this.version };
  }

  private ensureComputation(userId: string, version: number): Computation {
    const existing = this.inflight.get(userId);
    if (existing && existing.version === version) {
      return existing;
    }
    const computation: Computation = { version, listeners: new Set() };
    this.inflight.set(userId, computation);
    this.compute(userId, version).then(
      (items) => this.settle(userId, computation, true, items),
      () => this.settle(userId, computation, false, undefined)
    );
    return computation;
  }

  private settle(
    userId: string,
    computation: Computation,
    succeeded: boolean,
    items: RecommendationList | undefined
  ): void {
    // A late success only updates the cache if its version is still current.
    if (succeeded && computation.version === this.version && items) {
      this.cache.set(userId, {
        version: computation.version,
        items,
        completedAt: Date.now(),
      });
    }
    // Only remove the inflight entry if it is still this computation;
    // a stale computation must not clear a newer one.
    if (this.inflight.get(userId) === computation) {
      this.inflight.delete(userId);
    }
    for (const listener of [...computation.listeners]) {
      listener(succeeded);
    }
  }

  private waitFor(
    computation: Computation,
    remainingMs: number
  ): Promise<WaitOutcome> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (outcome: WaitOutcome): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        this.versionListeners.delete(onVersionChange);
        computation.listeners.delete(onSettle);
        resolve(outcome);
      };
      const onVersionChange = (): void => finish("version-changed");
      const onSettle: SettleListener = (succeeded) =>
        finish(succeeded ? "success" : "failure");
      const timer = setTimeout(() => finish("timeout"), remainingMs);
      this.versionListeners.add(onVersionChange);
      computation.listeners.add(onSettle);
    });
  }
}
