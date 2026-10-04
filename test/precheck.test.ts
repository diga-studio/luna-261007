import { test } from 'node:test';
import assert from 'node:assert/strict';
import { precheck, rolesAt, Snapshot } from '../src/index.js';
import type { Employee, Exemption, Grant, OrgNode, SnapshotData } from '../src/index.js';

const Q = { start: 0, end: 1000 };

function emp(id: string, orgNodeId: string): Employee {
  return { id, orgNodeId };
}
function node(id: string, parentId: string | null): OrgNode {
  return { id, parentId };
}
function orgGrant(id: string, orgNodeId: string, roleId: string, resourceId: string, start: number, end?: number): Grant {
  return { id, target: { kind: 'orgNode', orgNodeId }, roleId, resourceId, range: end === undefined ? { start } : { start, end } };
}
function empGrant(id: string, employeeId: string, roleId: string, resourceId: string, start: number, end?: number): Grant {
  return { id, target: { kind: 'employee', employeeId }, roleId, resourceId, range: end === undefined ? { start } : { start, end } };
}
function exemption(id: string, employeeId: string, resourceId: string, roleA: string, roleB: string, start: number, end?: number): Exemption {
  return { id, employeeId, resourceId, roleA, roleB, range: end === undefined ? { start } : { start, end } };
}
function snap(data: Partial<SnapshotData> & Pick<SnapshotData, 'employees' | 'orgNodes'>): Snapshot {
  return new Snapshot({
    grants: [],
    exemptions: [],
    policy: { mutexPairs: [{ roleA: 'A', roleB: 'B' }] },
    ...data,
  });
}

test('祖先组织授权与个人授权交叠产生冲突', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('R', null), node('D', 'R')],
    grants: [orgGrant('G1', 'R', 'A', 'X', 100, 200), empGrant('G2', 'E1', 'B', 'X', 150, 250)],
  });
  const r = precheck(s, { range: Q });
  assert.deepEqual(r.conflicts, [
    { employeeId: 'E1', resourceId: 'X', roleA: 'A', roleB: 'B', start: 150, end: 200 },
  ]);
});

test('撤回一个来源后角色仍由其他来源保持有效', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('R', null), node('D', 'R')],
    grants: [
      orgGrant('G1', 'R', 'A', 'X', 100, 300),
      empGrant('G2', 'E1', 'A', 'X', 150, 400),
      empGrant('G3', 'E1', 'B', 'X', 0, 500),
    ],
  });
  const full = precheck(s, { range: Q });
  assert.deepEqual(full.conflicts.map((c) => [c.start, c.end]), [[100, 400]]);

  const revokedOrg = precheck(s, { range: Q, adjustment: { removedGrantIds: ['G1'] } });
  assert.deepEqual(revokedOrg.conflicts.map((c) => [c.start, c.end]), [[150, 400]]);
  assert.ok(rolesAt(s, 'E1', 'X', 250, { removedGrantIds: ['G1'] }).has('A'));

  const revokedPersonal = precheck(s, { range: Q, adjustment: { removedGrantIds: ['G2'] } });
  assert.deepEqual(revokedPersonal.conflicts.map((c) => [c.start, c.end]), [[100, 300]]);
  assert.ok(rolesAt(s, 'E1', 'X', 250, { removedGrantIds: ['G2'] }).has('A'));
});

test('首尾相接的授权时段合并为一段冲突', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('D', null)],
    grants: [
      empGrant('G1', 'E1', 'A', 'X', 0, 100),
      empGrant('G2', 'E1', 'A', 'X', 100, 200),
      empGrant('G3', 'E1', 'B', 'X', 0, 200),
    ],
  });
  const r = precheck(s, { range: Q });
  assert.deepEqual(r.conflicts.map((c) => [c.start, c.end]), [[0, 200]]);
});

test('跨资源不构成冲突', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('D', null)],
    grants: [empGrant('G1', 'E1', 'A', 'X', 0, 500), empGrant('G2', 'E1', 'B', 'Y', 0, 500)],
  });
  assert.deepEqual(precheck(s, { range: Q }).conflicts, []);
});

test('多个交叠豁免共同覆盖并拆分冲突段', () => {
  const s = snap({
    employees: [emp('E1', 'D'), emp('E2', 'D')],
    orgNodes: [node('D', null)],
    grants: [empGrant('G1', 'E1', 'A', 'X', 0, 100), empGrant('G2', 'E1', 'B', 'X', 0, 100)],
    exemptions: [
      exemption('X1', 'E1', 'X', 'A', 'B', 10, 50),
      exemption('X2', 'E1', 'X', 'A', 'B', 40, 80),
      exemption('X3', 'E2', 'X', 'A', 'B', 0, 100),
      exemption('X4', 'E1', 'Y', 'A', 'B', 0, 100),
      exemption('X5', 'E1', 'X', 'A', 'C', 0, 100),
    ],
  });
  const r = precheck(s, { range: Q });
  assert.deepEqual(r.conflicts.map((c) => [c.start, c.end]), [
    [0, 10],
    [80, 100],
  ]);
});

test('未来生效的授权只在生效后产生冲突', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('D', null)],
    grants: [empGrant('G1', 'E1', 'A', 'X', 0, 900), empGrant('G2', 'E1', 'B', 'X', 800)],
  });
  const r = precheck(s, { range: Q });
  assert.deepEqual(r.conflicts.map((c) => [c.start, c.end]), [[800, 900]]);
});

test('无限期授权冲突延伸到查询末尾', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('D', null)],
    grants: [empGrant('G1', 'E1', 'A', 'X', 100), empGrant('G2', 'E1', 'B', 'X', 200)],
  });
  const r = precheck(s, { range: Q });
  assert.deepEqual(r.conflicts.map((c) => [c.start, c.end]), [[200, 1000]]);
});

test('新增授权的调整方案参与预检', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('D', null)],
    grants: [empGrant('G1', 'E1', 'A', 'X', 0, 500)],
  });
  const added = empGrant('G9', 'E1', 'B', 'X', 400, 600);
  const r = precheck(s, { range: Q, adjustment: { addedGrants: [added] } });
  assert.deepEqual(r.conflicts.map((c) => [c.start, c.end]), [[400, 500]]);
  assert.deepEqual(precheck(s, { range: Q }).conflicts, []);
});

test('深层组织链（非三层）上的祖先授权生效', () => {
  const nodes = [node('N0', null)];
  for (let i = 1; i <= 5; i++) nodes.push(node(`N${i}`, `N${i - 1}`));
  const s = snap({
    employees: [emp('E1', 'N5')],
    orgNodes: nodes,
    grants: [orgGrant('G1', 'N0', 'A', 'X', 0, 500), empGrant('G2', 'E1', 'B', 'X', 100, 600)],
  });
  const r = precheck(s, { range: Q });
  assert.deepEqual(r.conflicts.map((c) => [c.start, c.end]), [[100, 500]]);
});

test('重复授权不产生重复冲突', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('D', null)],
    grants: [
      empGrant('G1', 'E1', 'A', 'X', 0, 500),
      empGrant('G2', 'E1', 'A', 'X', 0, 500),
      empGrant('G3', 'E1', 'B', 'X', 0, 500),
    ],
  });
  const r = precheck(s, { range: Q });
  assert.equal(r.conflicts.length, 1);
});

test('rolesAt 反映组织继承、时刻与无限期授权', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('R', null), node('D', 'R')],
    grants: [
      orgGrant('G1', 'R', 'A', 'X', 100, 200),
      empGrant('G2', 'E1', 'B', 'X', 0, 500),
      empGrant('G3', 'E1', 'C', 'X', 300),
    ],
  });
  assert.deepEqual([...rolesAt(s, 'E1', 'X', 50)].sort(), ['B']);
  assert.deepEqual([...rolesAt(s, 'E1', 'X', 150)].sort(), ['A', 'B']);
  assert.deepEqual([...rolesAt(s, 'E1', 'X', 200)].sort(), ['B']);
  assert.deepEqual([...rolesAt(s, 'E1', 'X', 999)].sort(), ['C']);
  assert.deepEqual([...rolesAt(s, 'E1', 'X', 150, { removedGrantIds: ['G1'] })], ['B']);
  assert.equal(rolesAt(s, 'E1', 'Y', 150).size, 0);
});

test('角色对顺序无关：策略与豁免写法不同仍匹配', () => {
  const s = new Snapshot({
    employees: [emp('E1', 'D')],
    orgNodes: [node('D', null)],
    grants: [empGrant('G1', 'E1', 'A', 'X', 0, 100), empGrant('G2', 'E1', 'B', 'X', 0, 100)],
    policy: { mutexPairs: [{ roleA: 'B', roleB: 'A' }] },
    exemptions: [exemption('X1', 'E1', 'X', 'B', 'A', 20, 60)],
  });
  const r = precheck(s, { range: Q });
  assert.deepEqual(r.conflicts, [
    { employeeId: 'E1', resourceId: 'X', roleA: 'A', roleB: 'B', start: 0, end: 20 },
    { employeeId: 'E1', resourceId: 'X', roleA: 'A', roleB: 'B', start: 60, end: 100 },
  ]);
});

test('查询范围校验', () => {
  const s = snap({ employees: [], orgNodes: [] });
  assert.throws(() => precheck(s, { range: { start: 100, end: 100 } }));
  assert.throws(() => precheck(s, { range: { start: 200, end: 100 } }));
  assert.throws(() => precheck(s, { range: { start: 0, end: 3661 * 24 * 3600 * 1000 } }));
  assert.throws(() => precheck(s, { range: { start: 0.5, end: 100 } }));
});

test('调整方案校验', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('D', null)],
    grants: [empGrant('G1', 'E1', 'A', 'X', 0, 100)],
  });
  assert.throws(() => precheck(s, { range: Q, adjustment: { removedGrantIds: ['NOPE'] } }));
  assert.throws(() =>
    precheck(s, { range: Q, adjustment: { addedGrants: [empGrant('G1', 'E1', 'B', 'X', 0, 100)] } }),
  );
});

test('预检与角色查看后原快照保持不变', () => {
  const data: SnapshotData = {
    employees: [emp('E1', 'D'), emp('E2', 'D')],
    orgNodes: [node('R', null), node('D', 'R')],
    grants: [
      orgGrant('G1', 'R', 'A', 'X', 0, 800),
      empGrant('G2', 'E1', 'B', 'X', 100, 900),
      empGrant('G3', 'E2', 'B', 'X', 0, 500),
    ],
    policy: { mutexPairs: [{ roleA: 'A', roleB: 'B' }] },
    exemptions: [exemption('X1', 'E1', 'X', 'A', 'B', 200, 300)],
  };
  const before = JSON.stringify(data);
  const s = new Snapshot(data);
  const snapshotBefore = JSON.stringify({
    employees: s.employees,
    orgNodes: s.orgNodes,
    grants: s.grants,
    policy: s.policy,
    exemptions: s.exemptions,
  });
  precheck(s, { range: Q, adjustment: { removedGrantIds: ['G2'], addedGrants: [empGrant('G9', 'E1', 'C', 'X', 0, 100)] } });
  precheck(s, { range: Q });
  rolesAt(s, 'E1', 'X', 150, { removedGrantIds: ['G1'] });
  assert.equal(JSON.stringify(data), before);
  assert.equal(
    JSON.stringify({
      employees: s.employees,
      orgNodes: s.orgNodes,
      grants: s.grants,
      policy: s.policy,
      exemptions: s.exemptions,
    }),
    snapshotBefore,
  );
});

test('毫秒级短暂冲突必须被发现', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('D', null)],
    grants: [empGrant('G1', 'E1', 'A', 'X', 0, 1000), empGrant('G2', 'E1', 'B', 'X', 500, 501)],
  });
  const r = precheck(s, { range: Q });
  assert.deepEqual(r.conflicts.map((c) => [c.start, c.end]), [[500, 501]]);
});

test('授权来源变化但冲突不中断时不拆段', () => {
  const s = snap({
    employees: [emp('E1', 'D')],
    orgNodes: [node('R', null), node('D', 'R')],
    grants: [
      orgGrant('G1', 'R', 'A', 'X', 0, 100),
      empGrant('G2', 'E1', 'A', 'X', 100, 200),
      empGrant('G3', 'E1', 'B', 'X', 0, 200),
    ],
  });
  const r = precheck(s, { range: Q });
  assert.deepEqual(r.conflicts.map((c) => [c.start, c.end]), [[0, 200]]);
});
