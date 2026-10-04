import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheck, rolesAt, Snapshot } from '../src/index.js';
import type {
  Adjustment,
  ConflictSegment,
  Employee,
  Exemption,
  Grant,
  Millis,
  MutexPair,
  OrgNode,
  SnapshotData,
} from '../src/index.js';

/** 确定性伪随机数发生器 */
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

interface RefInput {
  data: SnapshotData;
  adjustment: Adjustment | undefined;
  range: { start: Millis; end: Millis };
}

function effectiveGrants(data: SnapshotData, adj: Adjustment | undefined): Grant[] {
  const removed = new Set(adj?.removedGrantIds ?? []);
  const out = data.grants.filter((g) => !removed.has(g.id));
  out.push(...(adj?.addedGrants ?? []));
  return out;
}

function ancestorsOf(orgNodes: readonly OrgNode[], orgNodeId: string): Set<string> {
  const byId = new Map(orgNodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  let cur: string | null = orgNodeId;
  while (cur !== null) {
    out.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return out;
}

function roleActiveAt(grants: readonly Grant[], emp: Employee, ancestors: ReadonlySet<string>, resourceId: string, roleId: string, at: Millis): boolean {
  for (const g of grants) {
    if (g.resourceId !== resourceId || g.roleId !== roleId) continue;
    const end = g.range.end ?? Infinity;
    if (!(g.range.start <= at && at < end)) continue;
    if (g.target.kind === 'employee' && g.target.employeeId === emp.id) return true;
    if (g.target.kind === 'orgNode' && ancestors.has(g.target.orgNodeId)) return true;
  }
  return false;
}

function pairKeyOf(a: string, b: string): string {
  return a < b ? `${a}${b}` : `${b}${a}`;
}

function exemptedAt(exemptions: readonly Exemption[], empId: string, resourceId: string, roleA: string, roleB: string, at: Millis): boolean {
  const key = pairKeyOf(roleA, roleB);
  for (const ex of exemptions) {
    if (ex.employeeId !== empId || ex.resourceId !== resourceId) continue;
    if (pairKeyOf(ex.roleA, ex.roleB) !== key) continue;
    const end = ex.range.end ?? Infinity;
    if (ex.range.start <= at && at < end) return true;
  }
  return false;
}

/** 参考实现：按业务定义在事件点间逐段判定，再合并相邻冲突段 */
function referencePrecheck(input: RefInput): ConflictSegment[] {
  const { data, adjustment, range } = input;
  const grants = effectiveGrants(data, adjustment);
  const out: ConflictSegment[] = [];
  for (const emp of data.employees) {
    const ancestors = ancestorsOf(data.orgNodes, emp.orgNodeId);
    const resources = new Set<string>();
    for (const g of grants) resources.add(g.resourceId);
    for (const resourceId of resources) {
      for (const pair of data.policy.mutexPairs) {
        const points = new Set<Millis>([range.start, range.end]);
        for (const g of grants) {
          if (g.resourceId !== resourceId) continue;
          points.add(Math.max(g.range.start, range.start));
          points.add(Math.min(g.range.end ?? range.end, range.end));
        }
        for (const ex of data.exemptions) {
          if (ex.employeeId !== emp.id || ex.resourceId !== resourceId) continue;
          points.add(Math.max(ex.range.start, range.start));
          points.add(Math.min(ex.range.end ?? range.end, range.end));
        }
        const sorted = [...points].filter((p) => p >= range.start && p <= range.end).sort((a, b) => a - b);
        const [roleA, roleB] = pair.roleA < pair.roleB ? [pair.roleA, pair.roleB] : [pair.roleB, pair.roleA];
        let segStart: Millis | null = null;
        for (let i = 0; i + 1 < sorted.length; i++) {
          const s = sorted[i]!;
          const e = sorted[i + 1]!;
          if (s >= e) continue;
          const mid = s + (e - s) / 2;
          const conflict =
            roleActiveAt(grants, emp, ancestors, resourceId, roleA!, mid) &&
            roleActiveAt(grants, emp, ancestors, resourceId, roleB!, mid) &&
            !exemptedAt(data.exemptions, emp.id, resourceId, roleA!, roleB!, mid);
          if (conflict && segStart === null) segStart = s;
          if (!conflict && segStart !== null) {
            out.push({ employeeId: emp.id, resourceId, roleA: roleA!, roleB: roleB!, start: segStart, end: s });
            segStart = null;
          }
        }
        if (segStart !== null) {
          out.push({ employeeId: emp.id, resourceId, roleA: roleA!, roleB: roleB!, start: segStart, end: range.end });
        }
      }
    }
  }
  return out;
}

function normalize(conflicts: readonly ConflictSegment[]): string {
  return conflicts
    .map((c) => `${c.employeeId}|${c.resourceId}|${c.roleA}|${c.roleB}|${c.start}|${c.end}`)
    .sort()
    .join('\n');
}

function randomCase(rand: () => number, seed: number): RefInput {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const nNodes = 2 + Math.floor(rand() * 4);
  const orgNodes: OrgNode[] = [{ id: 'N0', parentId: null }];
  for (let i = 1; i < nNodes; i++) {
    orgNodes.push({ id: `N${i}`, parentId: pick(orgNodes).id });
  }
  const nEmps = 1 + Math.floor(rand() * 4);
  const employees: Employee[] = [];
  for (let i = 0; i < nEmps; i++) employees.push({ id: `E${i}`, orgNodeId: pick(orgNodes).id });

  const roles = ['A', 'B', 'C', 'D'];
  const resources = ['X', 'Y'];
  const mutexPairs: MutexPair[] = [{ roleA: 'A', roleB: 'B' }];
  if (rand() < 0.5) mutexPairs.push({ roleA: 'C', roleB: 'D' });

  const grants: Grant[] = [];
  const nGrants = Math.floor(rand() * 9);
  for (let i = 0; i < nGrants; i++) {
    const start = Math.floor(rand() * 30);
    const len = 1 + Math.floor(rand() * 20);
    const open = rand() < 0.2;
    const target = rand() < 0.4
      ? { kind: 'orgNode' as const, orgNodeId: pick(orgNodes).id }
      : { kind: 'employee' as const, employeeId: pick(employees).id };
    grants.push({
      id: `G${i}`,
      target,
      roleId: pick(roles),
      resourceId: pick(resources),
      range: open ? { start } : { start, end: start + len },
    });
  }

  const exemptions: Exemption[] = [];
  const nEx = Math.floor(rand() * 5);
  for (let i = 0; i < nEx; i++) {
    const pair = pick(mutexPairs);
    const start = Math.floor(rand() * 30);
    const len = 1 + Math.floor(rand() * 15);
    exemptions.push({
      id: `X${i}`,
      employeeId: pick(employees).id,
      resourceId: pick(resources),
      roleA: pair.roleA,
      roleB: pair.roleB,
      range: rand() < 0.2 ? { start } : { start, end: start + len },
    });
  }

  let adjustment: Adjustment | undefined;
  if (grants.length > 0 && rand() < 0.6) {
    const removedGrantIds = grants.filter(() => rand() < 0.3).map((g) => g.id);
    const addedGrants: Grant[] = [];
    if (rand() < 0.5) {
      const start = Math.floor(rand() * 30);
      addedGrants.push({
        id: `NEW${seed}`,
        target: { kind: 'employee', employeeId: pick(employees).id },
        roleId: pick(roles),
        resourceId: pick(resources),
        range: { start, end: start + 1 + Math.floor(rand() * 15) },
      });
    }
    adjustment = { removedGrantIds, addedGrants };
  }

  const rangeStart = Math.floor(rand() * 10);
  const range = { start: rangeStart, end: rangeStart + 10 + Math.floor(rand() * 25) };
  return { data: { employees, orgNodes, grants, exemptions, policy: { mutexPairs } }, adjustment, range };
}

test('随机小案例与参考实现完全一致（含 rolesAt）', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rand = mulberry32(seed);
    const input = randomCase(rand, seed);
    const snapshot = new Snapshot(input.data);
    const actual = precheck(snapshot, { range: input.range, adjustment: input.adjustment });
    const expected = referencePrecheck(input);
    assert.equal(
      normalize(actual.conflicts),
      normalize(expected),
      `seed=${seed} 冲突段不一致`,
    );

    const grants = effectiveGrants(input.data, input.adjustment);
    for (const emp of input.data.employees) {
      const ancestors = ancestorsOf(input.data.orgNodes, emp.orgNodeId);
      for (const resourceId of ['X', 'Y']) {
        for (let at = input.range.start; at < input.range.end; at++) {
          const expectedRoles = new Set<string>();
          for (const role of ['A', 'B', 'C', 'D']) {
            if (roleActiveAt(grants, emp, ancestors, resourceId, role, at)) expectedRoles.add(role);
          }
          const actualRoles = rolesAt(snapshot, emp.id, resourceId, at, input.adjustment);
          assert.deepEqual(
            [...actualRoles].sort(),
            [...expectedRoles].sort(),
            `seed=${seed} rolesAt(${emp.id}, ${resourceId}, ${at})`,
          );
        }
      }
    }
  }
});
