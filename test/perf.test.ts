import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot, precheck } from '../src/index';
import { MAX_RANGE_MS } from '../src/precheck';
import type { Adjustment, Employee, Exemption, Grant, OrgNode, Policy } from '../src/types';
import { makeRng } from './helpers';

interface MutableData {
  orgNodes: OrgNode[];
  employees: Employee[];
  grants: Grant[];
  exemptions: Exemption[];
}

const YEAR = 365 * 24 * 60 * 60 * 1000;
const MiB = 1024 * 1024;

/**
 * 规模验证：2000 员工、4000 组织节点、50 角色、20 资源、100000 授权、10000 豁免。
 * 大量员工共享祖先授权、授权高度重叠、报告段数 <= 10000。
 * 要求：完整预检 < 5s，进程堆内存 < 256 MiB。
 */
test('规模场景：5 秒内完成且堆内存不超过 256 MiB', () => {
  const rng = makeRng(20261007);
  const rand = (n: number): number => Math.floor(rng() * n);

  // 4000 个组织节点：8 叉树（深度约 5），不假设固定三层
  const data: MutableData = {
    orgNodes: [{ id: 'o0', parentId: null }],
    employees: [],
    grants: [],
    exemptions: [],
  };
  for (let i = 1; i < 4000; i++) {
    data.orgNodes.push({ id: `o${i}`, parentId: `o${Math.floor((i - 1) / 8)}` });
  }
  // 2000 名员工分布在不同节点
  for (let i = 0; i < 2000; i++) {
    data.employees.push({ id: `e${i}`, orgNodeId: `o${1 + rand(3999)}` });
  }

  const roles = Array.from({ length: 50 }, (_, i) => `r${i}`);
  const resources = Array.from({ length: 20 }, (_, i) => `res${i}`);
  const range = { start: 0, end: MAX_RANGE_MS };
  const window = (): { start: number; end?: number } => {
    const start = rand(5 * YEAR);
    if (rng() < 0.2) return { start }; // 长期授权
    return { start, end: start + 1 + rand(6 * YEAR) };
  };

  // 85000 条组织授权：挂在根及高层节点，高度重叠，全员共享（仅使用非策略角色 r15..r49）
  const topNodes = ['o0', 'o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8'];
  for (let i = 0; i < 85000; i++) {
    const w = window();
    data.grants.push({
      id: `g${i}`,
      subject: { kind: 'org', orgNodeId: topNodes[rand(topNodes.length)]! },
      roleId: roles[15 + rand(35)]!,
      resourceId: resources[rand(20)]!,
      ...w,
    });
  }
  // 保证全员在 res0/res1 上拥有 r0..r4（冲突的“左半边”）
  for (let r = 0; r < 5; r++) {
    for (let res = 0; res < 2; res++) {
      data.grants.push({
        id: `base-r${r}-res${res}`,
        subject: { kind: 'org', orgNodeId: 'o0' },
        roleId: `r${r}`,
        resourceId: `res${res}`,
        start: 0,
      });
    }
  }
  // 15000 条个人授权，其中 200 名员工获得冲突的“右半边” r10..r14
  let personalCount = 0;
  for (let i = 0; i < 200; i++) {
    for (let r = 10; r < 15; r++) {
      for (let res = 0; res < 2; res++) {
        data.grants.push({
          id: `p${personalCount++}`,
          subject: { kind: 'employee', employeeId: `e${i}` },
          roleId: `r${r}`,
          resourceId: `res${res}`,
          start: 0,
        });
      }
    }
  }
  while (personalCount < 15000) {
    const w = window();
    data.grants.push({
      id: `p${personalCount++}`,
      subject: { kind: 'employee', employeeId: `e${rand(2000)}` },
      roleId: roles[15 + rand(35)]!,
      resourceId: resources[rand(20)]!,
      ...w,
    });
  }
  assert.equal(data.grants.length, 85000 + 10 + 15000);

  // 10000 条豁免：部分覆盖冲突员工的冲突时段
  const pairList = Array.from({ length: 5 }, (_, i) => ({ roleA: `r${i}`, roleB: `r${i + 10}` }));
  for (let i = 0; i < 10000; i++) {
    const pair = pairList[rand(5)]!;
    const start = rand(8 * YEAR);
    data.exemptions.push({
      employeeId: `e${rand(400)}`,
      resourceId: `res${rand(2)}`,
      roleA: pair.roleA,
      roleB: pair.roleB,
      start,
      end: start + 1 + rand(2 * YEAR),
    });
  }

  const policy: Policy = { pairs: pairList };

  const buildStart = performance.now();
  const snapshot = createSnapshot(data);
  const buildMs = performance.now() - buildStart;

  // 调整：撤回 1000 条授权 + 新增 500 条
  const adjustments: Adjustment[] = [];
  for (let i = 0; i < 1000; i++) adjustments.push({ kind: 'revoke', grantId: `g${i * 80}` });
  for (let i = 0; i < 500; i++) {
    adjustments.push({
      kind: 'add',
      grant: {
        id: `new-${i}`,
        subject: { kind: 'employee', employeeId: `e${rand(2000)}` },
        roleId: roles[15 + rand(35)]!,
        resourceId: resources[rand(20)]!,
        start: rand(5 * YEAR),
        end: 8 * YEAR,
      } satisfies Grant,
    });
  }

  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const conflicts = precheck(snapshot, adjustments, policy, range);
  const elapsedMs = performance.now() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  global.gc?.();
  const heapRetained = process.memoryUsage().heapUsed;

  console.log(
    `  [perf] 快照构建 ${buildMs.toFixed(0)}ms；预检 ${elapsedMs.toFixed(0)}ms；` +
      `冲突段 ${conflicts.length}；堆增量 ${(Math.max(0, heapAfter - heapBefore) / MiB).toFixed(1)} MiB；` +
      `运行后堆 ${(heapRetained / MiB).toFixed(1)} MiB`,
  );

  assert.ok(conflicts.length > 0, '应检测到冲突');
  assert.ok(conflicts.length <= 10000, `报告段数应 <= 10000，实际 ${conflicts.length}`);
  assert.ok(elapsedMs < 5000, `预检耗时 ${elapsedMs.toFixed(0)}ms 超过 5s`);
  assert.ok(
    Math.max(heapAfter, heapRetained) < 256 * MiB,
    `堆内存超过 256 MiB: ${(Math.max(heapAfter, heapRetained) / MiB).toFixed(1)} MiB`,
  );

  // 结果按员工/资源/角色对/起始时刻有序，且无重复段
  for (let i = 1; i < conflicts.length; i++) {
    const a = conflicts[i - 1]!;
    const b = conflicts[i]!;
    const sameKey =
      a.employeeId === b.employeeId &&
      a.resourceId === b.resourceId &&
      a.roleA === b.roleA &&
      a.roleB === b.roleB;
    if (sameKey) assert.ok(a.end <= b.start, '同键冲突段不得重叠');
  }
});
