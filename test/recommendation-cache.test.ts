import { test } from "node:test";
import assert from "node:assert/strict";
import { RecommendationCache } from "../src/index.js";
import type { QueryResult, RecommendationList } from "../src/index.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface Deferred {
  resolve: (items: RecommendationList) => void;
  reject: (err: Error) => void;
}

interface Timed {
  result: QueryResult;
  elapsed: number;
}

const timed = (p: Promise<QueryResult>, t0: number): Promise<Timed> =>
  p.then((result) => ({ result, elapsed: Date.now() - t0 }));

test("staggered queries share one computation, degrade on their own deadlines, late success refreshes cache", async () => {
  const calls: string[] = [];
  let resolveCompute!: (items: RecommendationList) => void;
  const computePromise = new Promise<RecommendationList>((res) => {
    resolveCompute = res;
  });
  const cache = new RecommendationCache({
    initialVersion: 1,
    budgetMs: 150,
    freshMs: 60_000,
    compute: (userId, version) => {
      calls.push(`${userId}@v${version}`);
      return computePromise;
    },
  });

  const t0 = Date.now();
  const queryA = timed(cache.getRecommendations("u1"), t0);
  await sleep(50);
  const queryB = timed(cache.getRecommendations("u1"), t0);

  const [a, b] = await Promise.all([queryA, queryB]);
  // Both queries exhausted their own budgets before the computation finished.
  assert.equal(a.result.kind, "unavailable");
  assert.equal(b.result.kind, "unavailable");
  // A entered at t=0 with a 150ms budget; B entered at t=50 with its own budget.
  assert.ok(a.elapsed >= 130 && a.elapsed < 270, `A elapsed ${a.elapsed}`);
  assert.ok(b.elapsed >= 180 && b.elapsed < 340, `B elapsed ${b.elapsed}`);
  // Exactly one computation was started for both queries.
  assert.deepEqual(calls, ["u1@v1"]);

  // The computation finally succeeds, too late for A and B.
  resolveCompute(["u1@v1#item-1"]);
  await sleep(30);

  // The late success updated the cache: the next query hits it directly.
  const c = await cache.getRecommendations("u1");
  assert.equal(c.kind, "fresh");
  assert.equal(c.version, 1);
  if (c.kind === "fresh") {
    assert.deepEqual(c.items, ["u1@v1#item-1"]);
  }
  assert.deepEqual(calls, ["u1@v1"]);
});

test("version switches: out-of-order stale computations cannot pollute, pending queries keep their original deadline", async () => {
  const calls: string[] = [];
  const deferreds = new Map<string, Deferred>();
  const cache = new RecommendationCache({
    initialVersion: 1,
    budgetMs: 300,
    freshMs: 60_000,
    compute: (userId, version) => {
      const key = `${userId}@v${version}`;
      calls.push(key);
      return new Promise<RecommendationList>((resolve, reject) => {
        deferreds.set(key, { resolve, reject });
      });
    },
  });

  const t0 = Date.now();
  const queryA = timed(cache.getRecommendations("u1"), t0);
  const queryC = timed(cache.getRecommendations("u2"), t0);

  await sleep(50);
  cache.switchVersion(2);
  await sleep(50);
  cache.switchVersion(3);
  await sleep(50); // t ~= 150

  // Newest version succeeds first.
  deferreds.get("u1@v3")?.resolve(["u1@v3#item"]);
  await sleep(30); // t ~= 180
  // Old computations settle out of order afterwards: success, then failure.
  deferreds.get("u1@v1")?.resolve(["u1@v1#item"]);
  await sleep(10);
  deferreds.get("u1@v2")?.reject(new Error("stale failure"));

  // A waited through v1 -> v2 -> v3 and got the latest version's result,
  // within its original 300ms budget.
  const a = await queryA;
  assert.equal(a.result.kind, "fresh");
  assert.equal(a.result.version, 3);
  if (a.result.kind === "fresh") {
    assert.deepEqual(a.result.items, ["u1@v3#item"]);
  }
  assert.ok(a.elapsed < 300, `A elapsed ${a.elapsed}`);

  // C's computations never settle: it degrades at its original deadline,
  // the budget was not reset by the version switches.
  const c = await queryC;
  assert.equal(c.result.kind, "unavailable");
  assert.equal(c.result.version, 3);
  assert.ok(c.elapsed >= 280 && c.elapsed < 420, `C elapsed ${c.elapsed}`);

  // Each version was computed exactly once per user; new versions never
  // waited for the previous computation to finish.
  for (const key of ["u1@v1", "u1@v2", "u1@v3", "u2@v1", "u2@v2", "u2@v3"]) {
    assert.equal(calls.filter((k) => k === key).length, 1, key);
  }

  // The late v1 success did not overwrite the v3 cache: a new query hits
  // the v3 cache without starting another computation.
  const callsBefore = calls.length;
  const b = await cache.getRecommendations("u1");
  assert.equal(b.kind, "fresh");
  assert.equal(b.version, 3);
  if (b.kind === "fresh") {
    assert.deepEqual(b.items, ["u1@v3#item"]);
  }
  assert.equal(calls.length, callsBefore);
});

test("expired cache plus compute failure: stale fallback for cached user, unavailable for uncached user, others unaffected", async () => {
  const failing = new Set<string>();
  const cache = new RecommendationCache({
    initialVersion: 1,
    budgetMs: 150,
    freshMs: 120,
    compute: async (userId, version) => {
      await sleep(30);
      if (failing.has(userId)) {
        throw new Error(`compute failed for ${userId}`);
      }
      return [`${userId}@v${version}#item`];
    },
  });

  // Prime u1's cache with a successful result.
  const primed = await cache.getRecommendations("u1");
  assert.equal(primed.kind, "fresh");
  if (primed.kind === "fresh") {
    assert.deepEqual(primed.items, ["u1@v1#item"]);
  }

  // Let u1's cache entry reach its freshness limit and become stale.
  await sleep(140);

  failing.add("u1");
  failing.add("u2");
  const [r1, r2, r3] = await Promise.all([
    cache.getRecommendations("u1"),
    cache.getRecommendations("u2"),
    cache.getRecommendations("u3"),
  ]);

  // u1 has a stale cache from the current version: degraded fallback.
  assert.equal(r1.kind, "stale");
  assert.equal(r1.version, 1);
  if (r1.kind === "stale") {
    assert.deepEqual(r1.items, ["u1@v1#item"]);
  }
  // u2 has no cache at all: unavailable.
  assert.equal(r2.kind, "unavailable");
  // u3's computation succeeds normally.
  assert.equal(r3.kind, "fresh");
  if (r3.kind === "fresh") {
    assert.deepEqual(r3.items, ["u3@v1#item"]);
  }

  // The failure neither cleared u1's cache nor blocked recomputation:
  // once the computer recovers, a later query gets a fresh result.
  failing.delete("u1");
  const r4 = await cache.getRecommendations("u1");
  assert.equal(r4.kind, "fresh");
  if (r4.kind === "fresh") {
    assert.deepEqual(r4.items, ["u1@v1#item"]);
  }
});

test("50 concurrent queries share one computation per user; 10 users compute in parallel without queuing", async () => {
  const counts = new Map<string, number>();
  const t0 = Date.now();
  const cache = new RecommendationCache({
    initialVersion: 1,
    budgetMs: 1_000,
    freshMs: 60_000,
    compute: async (userId, version) => {
      counts.set(userId, (counts.get(userId) ?? 0) + 1);
      await sleep(userId === "slow-user" ? 400 : 50);
      return [`${userId}@v${version}#item`];
    },
  });

  // 50 concurrent queries on one user share a single (slow) computation.
  const slowQueries = Array.from({ length: 50 }, () =>
    timed(cache.getRecommendations("slow-user"), t0)
  );
  // 10 other users compute independently at the same time.
  const fastUsers = Array.from({ length: 10 }, (_, i) => `fast-user-${i}`);
  const fastQueries = fastUsers.map((u) =>
    timed(cache.getRecommendations(u), t0)
  );

  const fastResults = await Promise.all(fastQueries);
  for (const { result, elapsed } of fastResults) {
    assert.equal(result.kind, "fresh");
    // Not queued behind the slow user's computation.
    assert.ok(elapsed < 200, `fast user elapsed ${elapsed}`);
  }

  const slowResults = await Promise.all(slowQueries);
  for (const { result } of slowResults) {
    assert.equal(result.kind, "fresh");
    if (result.kind === "fresh") {
      assert.deepEqual(result.items, ["slow-user@v1#item"]);
    }
  }
  assert.equal(counts.get("slow-user"), 1);
  for (const u of fastUsers) {
    assert.equal(counts.get(u), 1);
  }
});
