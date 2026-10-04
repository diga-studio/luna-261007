import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAdjustments, createSnapshot, precheck } from '../src/index';
import { MAX_RANGE_MS } from '../src/precheck';
import type { Adjustment, Employee, Exemption, Grant, OrgNode, Policy, SnapshotData, TimeRange } from '../src/types';
import { makeRng, referencePrecheck, referenceRolesAt } from './helpers';

interface MutableData {
  orgNodes: OrgNode[];
  employees: Employee[];
  grants: Grant[];
  exemptions: Exemption[];
}

const POLICY: Policy = { pairs: [{ roleA: 'admin', roleB: 'auditor' }] };
const RANGE: TimeRange = { start: 0, end: 10_000 };

/** 组织：root -> dept -> team；员工 alice 在 team，bob 在 dept。 */
function baseData(): MutableData {
  return {
    orgNodes: [
      { id: 'root', parentId: null },
      { id: 'dept', parentId: 'root' },
      { id: 'team', parentId: 'dept' },
    ],
    employees: [
      { id: 'alice', orgNodeId: 'team' },
      { id: 'bob', orgNodeId: 'dept' },
    ],
    grants: [],
    exemptions: [],
  };
}

test('祖先组织授权与个人授权交叠产生冲突', () => {
  const data = baseData();
  data.grants.push(
    // dept 给全员 admin（alice 通过祖先链继承）
    { id: 'g1', subject: { kind: 'org', orgNodeId: 'dept' }, roleId: 'admin', resourceId: 'db', start: 100, end: 900 },
    // alice 个人申请 auditor
    { id: 'g2', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'db', start: 500, end: 800 },
  );
  const snapshot = createSnapshot(data);
  const conflicts = precheck(snapshot, [], POLICY, RANGE);
  assert.deepEqual(conflicts, [
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 500, end: 800 },
  ]);
  // bob 只有 admin，无冲突
});

test('撤回其中一个来源后角色仍然有效', () => {
  const data = baseData();
  data.grants.push(
    { id: 'g1', subject: { kind: 'org', orgNodeId: 'dept' }, roleId: 'admin', resourceId: 'db', start: 0, end: 1000 },
    { id: 'g2', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'admin', resourceId: 'db', start: 0, end: 1000 },
    { id: 'g3', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'db', start: 0, end: 1000 },
  );
  const snapshot = createSnapshot(data);
  const adjustments: Adjustment[] = [{ kind: 'revoke', grantId: 'g1' }];
  // 组织来源被撤回，但个人来源仍提供 admin，冲突不变
  const conflicts = precheck(snapshot, adjustments, POLICY, RANGE);
  assert.deepEqual(conflicts, [
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 0, end: 1000 },
  ]);
  // rolesAt 同样认为 admin 仍有效
  const view = applyAdjustments(snapshot, adjustments);
  assert.deepEqual(view.rolesAt('alice', 'db', 500), ['admin', 'auditor']);
  // 两个来源都撤回后角色消失
  const both = precheck(
    snapshot,
    [{ kind: 'revoke', grantId: 'g1' }, { kind: 'revoke', grantId: 'g2' }],
    POLICY,
    RANGE,
  );
  assert.deepEqual(both, []);
});

test('首尾相接的冲突时段合并为一段，来源变化不拆段', () => {
  const data = baseData();
  data.grants.push(
    // admin 全程有效（组织授权）
    { id: 'g1', subject: { kind: 'org', orgNodeId: 'root' }, roleId: 'admin', resourceId: 'db', start: 0 },
    // auditor 来自两段首尾相接的授权
    { id: 'g2', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'db', start: 100, end: 500 },
    { id: 'g3', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'db', start: 500, end: 900 },
  );
  const snapshot = createSnapshot(data);
  const conflicts = precheck(snapshot, [], POLICY, RANGE);
  assert.deepEqual(conflicts, [
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 100, end: 900 },
  ]);
});

test('跨资源的相同角色对不构成冲突', () => {
  const data = baseData();
  data.grants.push(
    { id: 'g1', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'admin', resourceId: 'db', start: 0, end: 1000 },
    { id: 'g2', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'api', start: 0, end: 1000 },
  );
  const snapshot = createSnapshot(data);
  assert.deepEqual(precheck(snapshot, [], POLICY, RANGE), []);
});

test('多个交叠豁免共同覆盖，未覆盖部分拆成多段', () => {
  const data = baseData();
  data.grants.push(
    { id: 'g1', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'admin', resourceId: 'db', start: 0, end: 1000 },
    { id: 'g2', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'db', start: 0, end: 1000 },
  );
  data.exemptions.push(
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 100, end: 300 },
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 250, end: 400 }, // 与上一个交叠
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 700, end: 800 },
    // 其他员工的豁免不影响 alice
    { employeeId: 'bob', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 0, end: 1000 },
    // 其他角色对的豁免不影响本对
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'other', start: 0, end: 1000 },
  );
  const snapshot = createSnapshot(data);
  const conflicts = precheck(snapshot, [], POLICY, RANGE);
  assert.deepEqual(conflicts, [
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 0, end: 100 },
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 400, end: 700 },
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 800, end: 1000 },
  ]);
});

test('未来才生效的授权在查询范围内被正确发现', () => {
  const data = baseData();
  data.grants.push(
    { id: 'g1', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'admin', resourceId: 'db', start: 0, end: 5000 },
    { id: 'g2', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'db', start: 8000, end: 9000 },
  );
  const snapshot = createSnapshot(data);
  // 范围内没有交叠
  assert.deepEqual(precheck(snapshot, [], POLICY, { start: 0, end: 5000 }), []);
  // 扩大范围也没有交叠（admin 已结束）
  assert.deepEqual(precheck(snapshot, [], POLICY, RANGE), []);
  // admin 改为长期，则未来时段出现冲突
  const data2 = baseData();
  data2.grants.push(
    { id: 'g1', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'admin', resourceId: 'db', start: 0 },
    { id: 'g2', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'db', start: 8000, end: 9000 },
  );
  const conflicts = precheck(createSnapshot(data2), [], POLICY, RANGE);
  assert.deepEqual(conflicts, [
    { employeeId: 'alice', resourceId: 'db', roleA: 'admin', roleB: 'auditor', start: 8000, end: 9000 },
  ]);
});

test('新增授权的调整生效，且不修改原快照', () => {
  const data = baseData();
  data.grants.push(
    { id: 'g1', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'admin', resourceId: 'db', start: 0, end: 1000 },
  );
  const snapshot = createSnapshot(data);
  const before = JSON.stringify(data);
  const adjustments: Adjustment[] = [
    {
      kind: 'add',
      grant: { id: 'g2', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'db', start: 100, end: 200 },
    },
  ];
  const conflicts = precheck(snapshot, adjustments, POLICY, RANGE);
  assert.equal(conflicts.length, 1);
  // 原快照数据未被修改
  assert.equal(JSON.stringify(data), before);
  // 不应用调整时无冲突
  assert.deepEqual(precheck(snapshot, [], POLICY, RANGE), []);
});

test('深度冻结的快照在预检与角色查看后保持不变', () => {
  const data = baseData();
  data.grants.push(
    { id: 'g1', subject: { kind: 'org', orgNodeId: 'dept' }, roleId: 'admin', resourceId: 'db', start: 0, end: 1000 },
    { id: 'g2', subject: { kind: 'employee', employeeId: 'alice' }, roleId: 'auditor', resourceId: 'db', start: 0, end: 1000 },
  );
  const deepFreeze = (obj: unknown): void => {
    if (obj && typeof obj === 'object') {
      for (const v of Object.values(obj)) deepFreeze(v);
      Object.freeze(obj);
    }
  };
  deepFreeze(data);
  const snapshot = createSnapshot(data);
  const conflicts = precheck(snapshot, [], POLICY, RANGE);
  assert.equal(conflicts.length, 1);
  const view = applyAdjustments(snapshot, []);
  assert.deepEqual(view.rolesAt('alice', 'db', 10), ['admin', 'auditor']);
});

test('查询范围校验', () => {
  const snapshot = createSnapshot(baseData());
  assert.throws(() => precheck(snapshot, [], POLICY, { start: 100, end: 100 }), /end 必须大于 start/);
  assert.throws(() => precheck(snapshot, [], POLICY, { start: 0.5, end: 100 }), /整数毫秒/);
  assert.throws(
    () => precheck(snapshot, [], POLICY, { start: 0, end: MAX_RANGE_MS + 1 }),
    /10 年/,
  );
  // 恰好 10 年可用
  assert.doesNotThrow(() => precheck(snapshot, [], POLICY, { start: 0, end: MAX_RANGE_MS }));
});

test('随机小规模案例与参考实现完全一致', () => {
  const rng = makeRng(42);
  for (let round = 0; round < 50; round++) {
    const roles = ['r0', 'r1', 'r2', 'r3'];
    const resources = ['res0', 'res1'];
    const data: MutableData = {
      orgNodes: [
        { id: 'root', parentId: null },
        { id: 'n1', parentId: 'root' },
        { id: 'n2', parentId: 'n1' },
      ],
      employees: [
        { id: 'e0', orgNodeId: 'n2' },
        { id: 'e1', orgNodeId: 'n1' },
        { id: 'e2', orgNodeId: 'root' },
      ],
      grants: [],
      exemptions: [],
    };
    const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
    const grantCount = 1 + Math.floor(rng() * 12);
    for (let i = 0; i < grantCount; i++) {
      const start = Math.floor(rng() * 90);
      const end = rng() < 0.3 ? undefined : start + 1 + Math.floor(rng() * 30);
      const subject =
        rng() < 0.5
          ? { kind: 'employee' as const, employeeId: pick(['e0', 'e1', 'e2']) }
          : { kind: 'org' as const, orgNodeId: pick(['root', 'n1', 'n2']) };
      data.grants.push({
        id: `g${i}`,
        subject,
        roleId: pick(roles),
        resourceId: pick(resources),
        start,
        ...(end === undefined ? {} : { end }),
      });
    }
    const exCount = Math.floor(rng() * 5);
    for (let i = 0; i < exCount; i++) {
      const start = Math.floor(rng() * 90);
      const roleA = pick(roles);
      let roleB = pick(roles);
      if (roleB === roleA) roleB = roleA === 'r0' ? 'r1' : 'r0';
      data.exemptions.push({
        employeeId: pick(['e0', 'e1', 'e2']),
        resourceId: pick(resources),
        roleA,
        roleB,
        start,
        end: start + 1 + Math.floor(rng() * 20),
      });
    }
    const policy: Policy = {
      pairs: [
        { roleA: 'r0', roleB: 'r1' },
        { roleA: 'r2', roleB: 'r3' },
        { roleA: 'r1', roleB: 'r2' },
      ],
    };
    const range: TimeRange = { start: 0, end: 100 };
    const adjustments: Adjustment[] = [];
    if (data.grants.length > 0 && rng() < 0.7) {
      adjustments.push({ kind: 'revoke', grantId: pick(data.grants).id });
    }
    if (rng() < 0.5) {
      adjustments.push({
        kind: 'add',
        grant: {
          id: 'g-new',
          subject: { kind: 'employee', employeeId: pick(['e0', 'e1', 'e2']) },
          roleId: pick(roles),
          resourceId: pick(resources),
          start: Math.floor(rng() * 90),
          end: 100,
        },
      });
    }
    const snapshot = createSnapshot(data);
    const actual = precheck(snapshot, adjustments, policy, range);
    const expected = referencePrecheck(data, adjustments, policy, range);
    assert.deepEqual(actual, expected, `round ${round} 不一致`);

    // rolesAt 与参考实现一致
    for (const emp of data.employees) {
      for (const res of resources) {
        for (const t of [0, 25, 50, 75, 99]) {
          const view = applyAdjustments(snapshot, adjustments);
          assert.deepEqual(
            view.rolesAt(emp.id, res, t),
            referenceRolesAt(data, adjustments, emp.id, res, t),
            `rolesAt round ${round} ${emp.id} ${res} ${t}`,
          );
        }
      }
    }
  }
});
