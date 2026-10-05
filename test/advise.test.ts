import { test } from "node:test";
import assert from "node:assert/strict";
import { advise, WINDOW_MS } from "../src/index.js";
import type { AccessEvent, Grant, Snapshot, Triple } from "../src/index.js";

const T = 1_700_000_000_000; // 固定的分析基准时刻
const HOUR = 60 * 60 * 1000;

function triple(env: string, res: string, act: string): Triple {
  return { environment: env, resourceType: res, action: act };
}

function grant(id: number, ...keys: string[]): Grant {
  return {
    id,
    coverage: keys.map((k) => {
      const [environment, resourceType, action] = k.split("|");
      return { environment, resourceType, action };
    }),
  };
}

function hit(key: string, hoursAgo: number): AccessEvent {
  const [environment, resourceType, action] = key.split("|");
  return {
    triple: { environment, resourceType, action },
    timestamp: T - hoursAgo * HOUR,
    success: true,
  };
}

/** 独立核算：枚举全部子集，按题设目标取全局最优。 */
function bruteForce(snapshot: Snapshot): { keep: number[]; revoke: number[] } {
  const start = snapshot.now - WINDOW_MS;
  const evidence = new Set<string>();
  for (const e of snapshot.events) {
    if (!e.success || e.timestamp < start || e.timestamp >= snapshot.now) continue;
    evidence.add(keyOf(e.triple));
  }
  const grants = snapshot.grants.map((g) => ({
    id: g.id,
    keys: new Set(g.coverage.map(keyOf)),
  }));
  const n = grants.length;
  let best: { exposure: number; count: number; ids: number[] } | null = null;
  for (let mask = 0; mask < 1 << n; mask++) {
    const union = new Set<string>();
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        ids.push(grants[i].id);
        for (const k of grants[i].keys) union.add(k);
      }
    }
    let feasible = true;
    for (const ev of evidence) {
      if (!union.has(ev)) {
        feasible = false;
        break;
      }
    }
    if (!feasible) continue;
    let exposure = 0;
    for (const k of union) if (!evidence.has(k)) exposure++;
    const sorted = ids.slice().sort((a, b) => a - b);
    const candidate = { exposure, count: ids.length, ids: sorted };
    if (
      best === null ||
      candidate.exposure < best.exposure ||
      (candidate.exposure === best.exposure && candidate.count < best.count) ||
      (candidate.exposure === best.exposure &&
        candidate.count === best.count &&
        lexLess(candidate.ids, best.ids))
    ) {
      best = candidate;
    }
  }
  const keepSet = new Set(best!.ids);
  return {
    keep: best!.ids,
    revoke: grants.map((g) => g.id).filter((id) => !keepSet.has(id)).sort((a, b) => a - b),
  };
}

function keyOf(t: Triple): string {
  return `${t.environment}${t.resourceType}${t.action}`;
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

test("授权数量最少的方案不是暴露最小时，选择暴露最小", () => {
  // 证据 a、b。授权1一项即可覆盖全部证据但暴露 3 个未访问三元组；
  // 授权2+3 共两项，暴露为 0。应选 {2,3} 而非 {1}。
  const snapshot: Snapshot = {
    now: T,
    grants: [
      grant(1, "prod|db|read", "prod|db|write", "prod|db|delete", "prod|db|admin"),
      grant(2, "prod|db|read"),
      grant(3, "prod|db|write"),
    ],
    events: [hit("prod|db|read", 1), hit("prod|db|write", 2)],
  };
  const result = advise(snapshot);
  assert.deepEqual(result.keep, [2, 3]);
  assert.deepEqual(result.revoke, [1]);
  assert.deepEqual(result, bruteForce(snapshot));
});

test("每项授权单独看都有证据，组合后仍能安全撤销冗余项", () => {
  // 三项授权各自都命中过访问，但 {3} 一项即可覆盖全部证据。
  const snapshot: Snapshot = {
    now: T,
    grants: [
      grant(1, "prod|db|read"),
      grant(2, "prod|db|write"),
      grant(3, "prod|db|read", "prod|db|write"),
    ],
    events: [hit("prod|db|read", 1), hit("prod|db|write", 2)],
  };
  const result = advise(snapshot);
  assert.deepEqual(result.keep, [3]);
  assert.deepEqual(result.revoke, [1, 2]);
  assert.deepEqual(result, bruteForce(snapshot));
});

test("证据窗口：含起点、不含T、忽略失败与重复", () => {
  const snapshot: Snapshot = {
    now: T,
    grants: [grant(1, "a|r|x"), grant(2, "b|r|x"), grant(3, "c|r|x"), grant(4, "d|r|x")],
    events: [
      hit("a|r|x", 720), // 恰好起点：计入
      hit("b|r|x", 719), // 窗口内：计入
      hit("b|r|x", 100), // 重复：仍只算一份
      { ...hit("c|r|x", 1), success: false }, // 失败：不计入
      hit("d|r|x", 721), // 窗口外：不计入
      hit("a|r|x", 0), // 恰好 T：不计入（但 a 已由起点事件计入）
    ],
  };
  const result = advise(snapshot);
  assert.deepEqual(result.keep, [1, 2]);
  assert.deepEqual(result.revoke, [3, 4]);
  assert.deepEqual(result, bruteForce(snapshot));
});

test("无访问证据时撤销全部授权", () => {
  const snapshot: Snapshot = {
    now: T,
    grants: [grant(1, "a|r|x"), grant(2, "b|r|x")],
    events: [],
  };
  const result = advise(snapshot);
  assert.deepEqual(result.keep, []);
  assert.deepEqual(result.revoke, [1, 2]);
  assert.deepEqual(result, bruteForce(snapshot));
});

test("结果不受授权顺序、日志顺序与重复日志影响", () => {
  const grants = [
    grant(5, "a|r|x", "b|r|x"),
    grant(2, "a|r|x"),
    grant(9, "c|r|x"),
    grant(3, "b|r|x", "c|r|x"),
  ];
  const events = [hit("a|r|x", 3), hit("b|r|x", 2), hit("c|r|x", 1)];
  const base = advise({ now: T, grants, events });

  const shuffledGrants = [grants[2], grants[0], grants[3], grants[1]];
  const shuffledEvents = [events[2], events[0], events[0], events[1], events[2]];
  const permuted = advise({ now: T, grants: shuffledGrants, events: shuffledEvents });

  assert.deepEqual(permuted, base);
  assert.deepEqual(base, bruteForce({ now: T, grants, events }));
});

test("暴露与数量均并列时，选择编号字典序最小的序列", () => {
  // {1,3}、{1,4}、{2,3}、{2,4} 都覆盖证据、暴露与数量相同，
  // 字典序最小的是 {1,3}。
  const snapshot: Snapshot = {
    now: T,
    grants: [
      grant(2, "a|r|x"),
      grant(3, "b|r|x"),
      grant(1, "a|r|x"),
      grant(4, "b|r|x"),
    ],
    events: [hit("a|r|x", 1), hit("b|r|x", 1)],
  };
  const result = advise(snapshot);
  assert.deepEqual(result.keep, [1, 3]);
  assert.deepEqual(result, bruteForce(snapshot));
});

test("重叠覆盖的暴露按并集计算、不重复计数", () => {
  // {1,2} 暴露并集 {z}（1个），{3} 暴露 {y}（1个）；数量上 {3} 更少，应选 {3}。
  const snapshot: Snapshot = {
    now: T,
    grants: [
      grant(1, "a|r|x", "z|r|x"),
      grant(2, "b|r|x", "z|r|x"),
      grant(3, "a|r|x", "b|r|x", "y|r|x"),
    ],
    events: [hit("a|r|x", 1), hit("b|r|x", 1)],
  };
  const result = advise(snapshot);
  assert.deepEqual(result.keep, [3]);
  assert.deepEqual(result, bruteForce(snapshot));
});

test("随机快照与独立核算结果一致", () => {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 50; round++) {
    const keyPool = Array.from({ length: 6 }, (_, i) => `e${i}|r${i}|a${i}`);
    const grants: Grant[] = [];
    const grantCount = 1 + Math.floor(rand() * 7);
    for (let id = 1; id <= grantCount; id++) {
      const keys = keyPool.filter(() => rand() < 0.4);
      grants.push(grant(id, ...keys));
    }
    const events: AccessEvent[] = [];
    for (const key of keyPool) {
      if (rand() < 0.5) events.push(hit(key, Math.floor(rand() * 720)));
    }
    // 保证题设前提：证据均可被当前授权覆盖。
    const covered = new Set(grants.flatMap((g) => g.coverage.map(keyOf)));
    const feasible = events.filter((e) => e.success).every((e) => covered.has(keyOf(e.triple)));
    if (!feasible) continue;
    const snapshot: Snapshot = { now: T, grants, events };
    assert.deepEqual(advise(snapshot), bruteForce(snapshot), `round ${round}`);
  }
});

test("非法授权编号抛错", () => {
  assert.throws(() =>
    advise({ now: T, grants: [grant(0, "a|r|x")], events: [] }),
  );
  assert.throws(() =>
    advise({ now: T, grants: [grant(1, "a|r|x"), grant(1, "b|r|x")], events: [] }),
  );
});
