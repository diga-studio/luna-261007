/**
 * 性能验证 worker：由 perf.test.ts 以受限堆（--max-old-space-size）的子进程方式运行。
 * 规模：2000 员工 / 4000 组织节点 / 50 角色 / 20 资源 / 100000 授权 / 10000 豁免。
 */
import { precheck, Snapshot } from '../src/index.js';
import type { Employee, Exemption, Grant, OrgNode } from '../src/index.js';

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

const DAY = 24 * 3600 * 1000;
const T0 = 1_700_000_000_000;

const N_EMP = 2000;
const N_NODE = 4000;
const N_ROLE = 50;
const N_RES = 20;
const N_PAIR = 10;

function build(): Snapshot {
  const rand = mulberry32(42);

  const orgNodes: OrgNode[] = [{ id: 'N0', parentId: null }];
  for (let i = 1; i < N_NODE; i++) {
    orgNodes.push({ id: `N${i}`, parentId: `N${(i - 1) >> 3}` });
  }

  const employees: Employee[] = [];
  for (let i = 0; i < N_EMP; i++) {
    employees.push({ id: `E${i}`, orgNodeId: `N${1 + Math.floor(rand() * (N_NODE - 1))}` });
  }

  const mutexPairs = [];
  for (let p = 0; p < N_PAIR; p++) mutexPairs.push({ roleA: `R${2 * p}`, roleB: `R${2 * p + 1}` });

  const grants: Grant[] = [];
  let gid = 0;

  // 90000 条个人授权：非互斥角色，制造大量重叠但不产生冲突
  for (let i = 0; i < 90000; i++) {
    const start = T0 + Math.floor(rand() * 365 * DAY);
    const open = rand() < 0.15;
    grants.push({
      id: `G${gid++}`,
      target: { kind: 'employee', employeeId: `E${Math.floor(rand() * N_EMP)}` },
      roleId: `R${N_PAIR * 2 + Math.floor(rand() * (N_ROLE - N_PAIR * 2))}`,
      resourceId: `RES${Math.floor(rand() * N_RES)}`,
      range: open ? { start } : { start, end: start + 1 + Math.floor(rand() * 400 * DAY) },
    });
  }

  // 5000 条组织授权：大量员工共享祖先授权
  for (let i = 0; i < 5000; i++) {
    const start = T0 + Math.floor(rand() * 180 * DAY);
    grants.push({
      id: `G${gid++}`,
      target: { kind: 'orgNode', orgNodeId: `N${Math.floor(rand() * 200)}` },
      roleId: `R${N_PAIR * 2 + Math.floor(rand() * (N_ROLE - N_PAIR * 2))}`,
      resourceId: `RES${Math.floor(rand() * N_RES)}`,
      range: { start, end: start + 1 + Math.floor(rand() * 500 * DAY) },
    });
  }

  // 5000 条冲突授权：2500 组互斥对（其中 2000 组键唯一）
  for (let i = 0; i < 2500; i++) {
    const empId = `E${i % N_EMP}`;
    const resId = `RES${i % N_RES}`;
    const p = i % N_PAIR;
    grants.push({
      id: `G${gid++}`,
      target: { kind: 'employee', employeeId: empId },
      roleId: `R${2 * p}`,
      resourceId: resId,
      range: { start: T0, end: T0 + 400 * DAY },
    });
    grants.push({
      id: `G${gid++}`,
      target: { kind: 'employee', employeeId: empId },
      roleId: `R${2 * p + 1}`,
      resourceId: resId,
      range: { start: T0 + 100 * DAY, end: T0 + 500 * DAY },
    });
  }

  // 10000 条豁免：前 2000 条精确命中冲突键并部分覆盖，将其拆成两段
  const exemptions: Exemption[] = [];
  for (let j = 0; j < 10000; j++) {
    const p = j % N_PAIR;
    exemptions.push({
      id: `X${j}`,
      employeeId: `E${j % N_EMP}`,
      resourceId: `RES${j % N_RES}`,
      roleA: `R${2 * p}`,
      roleB: `R${2 * p + 1}`,
      range: { start: T0 + 150 * DAY, end: T0 + 200 * DAY },
    });
  }

  return new Snapshot({ employees, orgNodes, grants, exemptions, policy: { mutexPairs } });
}

const snapshot = build();
if (typeof globalThis.gc === 'function') globalThis.gc();
const heapBefore = process.memoryUsage().heapUsed;

const t0 = performance.now();
const result = precheck(snapshot, { range: { start: T0, end: T0 + 365 * DAY } });
const elapsedMs = performance.now() - t0;

if (typeof globalThis.gc === 'function') globalThis.gc();
const heapAfter = process.memoryUsage().heapUsed;

console.log(
  JSON.stringify({
    elapsedMs: Math.round(elapsedMs),
    segments: result.conflicts.length,
    heapUsedMiB: Math.round((heapAfter / 1048576) * 10) / 10,
    heapDeltaMiB: Math.round(((heapAfter - heapBefore) / 1048576) * 10) / 10,
  }),
);
