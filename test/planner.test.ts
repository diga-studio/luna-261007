import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOLDING_CAPACITY,
  isClassCompliant,
  planTransfers,
} from '../src/index';
import type { ChildInput, ClassInput, Move, PlanInput } from '../src/index';

/** 逐步模拟移动方案，校验每步之后所有班与交接区合规，且最终达到目标分班 */
function simulateAndVerify(input: PlanInput, moves: readonly Move[]): void {
  const teachers = new Map(input.classes.map((c) => [c.id, c.teachers]));
  const members = new Map<string, ChildInput[]>();
  for (const klass of input.classes) {
    members.set(klass.id, []);
  }
  const location = new Map<string, string>(); // childId -> classId 或 'holding'
  for (const child of input.children) {
    members.get(child.initialClassId)!.push(child);
    location.set(child.id, child.initialClassId);
  }
  const holding: ChildInput[] = [];

  const checkAll = (step: number): void => {
    for (const klass of input.classes) {
      const present = members.get(klass.id)!.map((c) => c.category);
      assert.ok(
        isClassCompliant(teachers.get(klass.id)!, present),
        `第 ${step} 步后班级 ${klass.id} 不合规`,
      );
    }
    assert.ok(holding.length <= HOLDING_CAPACITY, `第 ${step} 步后交接区超员`);
  };

  checkAll(0);
  const byId = new Map(input.children.map((c) => [c.id, c]));
  moves.forEach((move, index) => {
    const child = byId.get(move.childId)!;
    if (move.kind === 'direct') {
      assert.equal(location.get(child.id), move.fromClassId);
      members.set(move.fromClassId, members.get(move.fromClassId)!.filter((c) => c.id !== child.id));
      members.get(move.toClassId)!.push(child);
      location.set(child.id, move.toClassId);
    } else if (move.kind === 'toHolding') {
      assert.equal(location.get(child.id), move.fromClassId);
      members.set(move.fromClassId, members.get(move.fromClassId)!.filter((c) => c.id !== child.id));
      holding.push(child);
      location.set(child.id, 'holding');
    } else {
      assert.equal(location.get(child.id), 'holding');
      holding.splice(holding.indexOf(child), 1);
      members.get(move.toClassId)!.push(child);
      location.set(child.id, move.toClassId);
    }
    checkAll(index + 1);
  });

  for (const child of input.children) {
    assert.equal(location.get(child.id), child.targetClassId, `儿童 ${child.id} 未到达目标班`);
  }
}

function infants(prefix: string, classId: string, count: number): ChildInput[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    category: 'infant',
    initialClassId: classId,
    targetClassId: classId,
  }));
}

test('三个婴儿班的目标环：总共 4 次移动完成', () => {
  const classes: ClassInput[] = [
    { id: 'A', teachers: 1 },
    { id: 'B', teachers: 1 },
    { id: 'C', teachers: 1 },
  ];
  // 各选 1 名儿童形成目标环：a0->B, b0->C, c0->A
  const retarget = (list: ChildInput[], id: string, target: string): ChildInput[] =>
    list.map((c) => (c.id === id ? { ...c, targetClassId: target } : c));
  let children: ChildInput[] = [
    ...infants('a', 'A', 4),
    ...infants('b', 'B', 4),
    ...infants('c', 'C', 4),
  ];
  children = retarget(children, 'a0', 'B');
  children = retarget(children, 'b0', 'C');
  children = retarget(children, 'c0', 'A');

  const input: PlanInput = { classes, children };
  const snapshot = JSON.stringify(input);
  const result = planTransfers(input);

  assert.ok(result.ok, '应当存在合法方案');
  assert.equal(result.moves.length, 4);
  simulateAndVerify(input, result.moves);
  assert.equal(JSON.stringify(input), snapshot, '规划不得修改调用方输入');
});

test('学前班与婴儿班全体对调：交接区仅容 2 人，判定无法完成', () => {
  const classes: ClassInput[] = [
    { id: 'P', teachers: 1 },
    { id: 'I', teachers: 1 },
  ];
  const children: ChildInput[] = [
    ...Array.from({ length: 10 }, (_, i) => ({
      id: `p${i}`,
      category: 'preschool' as const,
      initialClassId: 'P',
      targetClassId: 'I',
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `i${i}`,
      category: 'infant' as const,
      initialClassId: 'I',
      targetClassId: 'P',
    })),
  ];

  const result = planTransfers({ classes, children });
  assert.equal(result.ok, false);
});

test('目标班有余量时直接调班：1 次移动', () => {
  const classes: ClassInput[] = [
    { id: 'A', teachers: 1 },
    { id: 'B', teachers: 2 },
  ];
  const children: ChildInput[] = [
    { id: 'a0', category: 'infant', initialClassId: 'A', targetClassId: 'B' },
    ...infants('a', 'A', 3).map((c, i) => ({ ...c, id: `a${i + 1}` })),
    ...infants('b', 'B', 3),
  ];

  const input: PlanInput = { classes, children };
  const result = planTransfers(input);
  assert.ok(result.ok);
  assert.equal(result.moves.length, 1);
  assert.equal(result.moves[0].kind, 'direct');
  simulateAndVerify(input, result.moves);
});

test('无需调班时返回空方案', () => {
  const classes: ClassInput[] = [{ id: 'A', teachers: 1 }];
  const children = infants('a', 'A', 4);
  const result = planTransfers({ classes, children });
  assert.ok(result.ok);
  assert.equal(result.moves.length, 0);
});
