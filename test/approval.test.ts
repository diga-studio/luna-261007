import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalService } from '../src/index.js';

function makeService(): { svc: ApprovalService; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'forgekit-'));
  const dbPath = join(dir, 'approval.db');
  return { svc: new ApprovalService(dbPath), dir, dbPath };
}

function todoOf(svc: ApprovalService, person: string, instanceId: string): string {
  const todos = svc.listTodos(person).filter((t) => t.instanceId === instanceId);
  assert.equal(todos.length, 1, `expected exactly 1 todo for ${person}`);
  return todos[0].id;
}

test('逐层办理：仅当前层产生有效待办，后续层不得提前办理', () => {
  const { svc, dir } = makeService();
  try {
    const id = svc.submit({ initiator: 'root', fieldCount: 60, normalApprovers: ['alice', 'bob'], seniorApprovers: ['carol', 'dave'] });

    // 路径固定：普通层 + 高级层
    let inst = svc.getInstance(id);
    assert.equal(inst.layers.length, 2);
    assert.equal(inst.layers[0].status, 'active');
    assert.equal(inst.layers[1].status, 'pending');

    // 只有普通层有待办
    assert.equal(svc.listTodos('alice').length, 1);
    assert.equal(svc.listTodos('bob').length, 1);
    assert.equal(svc.listTodos('carol').length, 0);
    assert.equal(svc.listTodos('dave').length, 0);

    svc.act({ todoId: todoOf(svc, 'alice', id), operator: 'alice', action: 'approve' });
    inst = svc.getInstance(id);
    assert.equal(inst.layers[0].status, 'active'); // 未全员同意，层未完成
    assert.equal(svc.listTodos('carol').length, 0); // 高级层不得提前办理

    svc.act({ todoId: todoOf(svc, 'bob', id), operator: 'bob', action: 'approve' });
    inst = svc.getInstance(id);
    assert.equal(inst.layers[0].status, 'completed');
    assert.equal(inst.layers[1].status, 'active');
    assert.equal(svc.listTodos('carol').length, 1);
    assert.equal(svc.listTodos('dave').length, 1);
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('加签已完成层：回退后未受影响同意保留、后续层作废、旧待办不可复用', () => {
  const { svc, dir } = makeService();
  try {
    const id = svc.submit({ initiator: 'root', fieldCount: 60, normalApprovers: ['alice', 'bob'], seniorApprovers: ['carol', 'dave'] });
    svc.act({ todoId: todoOf(svc, 'alice', id), operator: 'alice', action: 'approve' });
    svc.act({ todoId: todoOf(svc, 'bob', id), operator: 'bob', action: 'approve' });
    const carolOldTodo = todoOf(svc, 'carol', id);
    const daveOldTodo = todoOf(svc, 'dave', id);
    svc.act({ todoId: carolOldTodo, operator: 'carol', action: 'approve' }); // 高级层部分同意

    // 在已完成的普通层加签 eve
    svc.addApprover(id, 0, 'eve');

    let inst = svc.getInstance(id);
    assert.equal(inst.status, 'active');
    assert.equal(inst.layers[0].status, 'active'); // 退回普通层
    assert.equal(inst.layers[1].status, 'pending');
    const l0 = inst.layers[0].approvers;
    assert.deepEqual(
      l0.map((a) => [a.person, a.approved]),
      [['alice', true], ['bob', true], ['eve', false]], // 既有同意保留，新增人须重新同意
    );
    const l1 = inst.layers[1].approvers;
    assert.deepEqual(
      l1.map((a) => [a.person, a.approved]),
      [['carol', false], ['dave', false]], // 高级层同意全部作废
    );

    // 待办：只有 eve；dave 旧待办失效，carol 旧待办已办
    assert.deepEqual(svc.listTodos('eve').map((t) => t.instanceId), [id]);
    assert.equal(svc.listTodos('carol').length, 0);
    assert.equal(svc.listTodos('dave').length, 0);

    // dave 旧待办不能再次办理
    svc.act({ todoId: daveOldTodo, operator: 'dave', action: 'approve' });
    inst = svc.getInstance(id);
    assert.equal(inst.layers[1].approvers.find((a) => a.person === 'dave')!.approved, false);

    // carol 旧待办（已办理）再次提交不改变实例
    svc.act({ todoId: carolOldTodo, operator: 'carol', action: 'approve' });
    inst = svc.getInstance(id);
    assert.equal(inst.layers[1].approvers.find((a) => a.person === 'carol')!.approved, false);

    // eve 同意后普通层重新完成，高级层重新审批
    svc.act({ todoId: todoOf(svc, 'eve', id), operator: 'eve', action: 'approve' });
    inst = svc.getInstance(id);
    assert.equal(inst.layers[0].status, 'completed');
    assert.equal(inst.layers[1].status, 'active');

    // carol 重新取得新待办，旧待办仍不能生效
    const carolNewTodo = todoOf(svc, 'carol', id);
    assert.notEqual(carolNewTodo, carolOldTodo);
    svc.act({ todoId: carolOldTodo, operator: 'carol', action: 'approve' });
    inst = svc.getInstance(id);
    assert.equal(inst.layers[1].approvers.find((a) => a.person === 'carol')!.approved, false);

    svc.act({ todoId: carolNewTodo, operator: 'carol', action: 'approve' });
    svc.act({ todoId: todoOf(svc, 'dave', id), operator: 'dave', action: 'approve' });
    inst = svc.getInstance(id);
    assert.equal(inst.status, 'approved');
    for (const p of ['alice', 'bob', 'eve', 'carol', 'dave']) {
      assert.equal(svc.listTodos(p).length, 0, `${p} should have no open todos`);
    }
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('改派当前层：原审批人待办失效，替换人须重新同意，他人同意保留', () => {
  const { svc, dir } = makeService();
  try {
    const id = svc.submit({ initiator: 'root', fieldCount: 30, normalApprovers: ['alice', 'bob'] });
    svc.act({ todoId: todoOf(svc, 'alice', id), operator: 'alice', action: 'approve' });
    const bobOldTodo = todoOf(svc, 'bob', id);

    svc.reassign(id, 0, 'bob', 'frank');

    let inst = svc.getInstance(id);
    assert.deepEqual(
      inst.layers[0].approvers.map((a) => [a.person, a.approved]),
      [['alice', true], ['frank', false]],
    );
    assert.equal(svc.listTodos('bob').length, 0);
    assert.equal(svc.listTodos('frank').length, 1);

    // bob 旧待办不能办理
    svc.act({ todoId: bobOldTodo, operator: 'bob', action: 'approve' });
    inst = svc.getInstance(id);
    assert.equal(inst.status, 'active');

    svc.act({ todoId: todoOf(svc, 'frank', id), operator: 'frank', action: 'approve' });
    assert.equal(svc.getInstance(id).status, 'approved');
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('改派已完成层：实例退回该层，后续层待办失效并重新审批', () => {
  const { svc, dir } = makeService();
  try {
    const id = svc.submit({ initiator: 'root', fieldCount: 60, normalApprovers: ['alice'], seniorApprovers: ['carol'] });
    svc.act({ todoId: todoOf(svc, 'alice', id), operator: 'alice', action: 'approve' });
    const carolOldTodo = todoOf(svc, 'carol', id);

    svc.reassign(id, 0, 'alice', 'henry');

    let inst = svc.getInstance(id);
    assert.equal(inst.layers[0].status, 'active');
    assert.equal(inst.layers[1].status, 'pending');
    assert.equal(svc.listTodos('carol').length, 0); // carol 待办失效
    assert.equal(svc.listTodos('henry').length, 1);

    // carol 旧待办不能办理
    svc.act({ todoId: carolOldTodo, operator: 'carol', action: 'approve' });
    assert.equal(svc.getInstance(id).layers[1].status, 'pending');

    svc.act({ todoId: todoOf(svc, 'henry', id), operator: 'henry', action: 'approve' });
    inst = svc.getInstance(id);
    assert.equal(inst.layers[1].status, 'active');
    const carolNewTodo = todoOf(svc, 'carol', id);
    assert.notEqual(carolNewTodo, carolOldTodo);
    svc.act({ todoId: carolNewTodo, operator: 'carol', action: 'approve' });
    assert.equal(svc.getInstance(id).status, 'approved');
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('驳回：实例终结，所有待办失效，终态不可改变', () => {
  const { svc, dir } = makeService();
  try {
    const id = svc.submit({ initiator: 'root', fieldCount: 60, normalApprovers: ['alice', 'bob'], seniorApprovers: ['carol'] });
    const aliceTodo = todoOf(svc, 'alice', id);
    const bobTodo = todoOf(svc, 'bob', id);
    svc.act({ todoId: aliceTodo, operator: 'alice', action: 'reject' });

    const inst = svc.getInstance(id);
    assert.equal(inst.status, 'rejected');
    for (const p of ['alice', 'bob', 'carol']) assert.equal(svc.listTodos(p).length, 0);

    // 旧待办不能改变终态
    svc.act({ todoId: bobTodo, operator: 'bob', action: 'approve' });
    svc.act({ todoId: aliceTodo, operator: 'alice', action: 'approve' });
    assert.equal(svc.getInstance(id).status, 'rejected');

    // 终态不能再加签、改派、撤回
    assert.throws(() => svc.addApprover(id, 0, 'eve'));
    assert.throws(() => svc.reassign(id, 0, 'alice', 'eve'));
    assert.throws(() => svc.withdraw(id, 'root'));
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('撤回：仅发起人，实例终结，所有待办失效', () => {
  const { svc, dir } = makeService();
  try {
    const id = svc.submit({ initiator: 'root', fieldCount: 10, normalApprovers: ['alice'] });
    const aliceTodo = todoOf(svc, 'alice', id);
    assert.throws(() => svc.withdraw(id, 'alice')); // 非发起人不能撤回
    svc.withdraw(id, 'root');

    assert.equal(svc.getInstance(id).status, 'withdrawn');
    assert.equal(svc.listTodos('alice').length, 0);
    svc.act({ todoId: aliceTodo, operator: 'alice', action: 'approve' }); // 旧待办无效
    assert.equal(svc.getInstance(id).status, 'withdrawn');
    assert.throws(() => svc.addApprover(id, 0, 'eve'));
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('通过后：无有效待办，旧待办不能改变终态', () => {
  const { svc, dir } = makeService();
  try {
    const id = svc.submit({ initiator: 'root', fieldCount: 50, normalApprovers: ['alice', 'bob'] });
    const aliceTodo = todoOf(svc, 'alice', id);
    const bobTodo = todoOf(svc, 'bob', id);
    svc.act({ todoId: aliceTodo, operator: 'alice', action: 'approve' });
    svc.act({ todoId: bobTodo, operator: 'bob', action: 'approve' });

    assert.equal(svc.getInstance(id).status, 'approved');
    assert.equal(svc.listTodos('alice').length, 0);
    assert.equal(svc.listTodos('bob').length, 0);
    svc.act({ todoId: aliceTodo, operator: 'alice', action: 'reject' }); // 已办待办无效
    assert.equal(svc.getInstance(id).status, 'approved');
    assert.throws(() => svc.addApprover(id, 0, 'eve'));
    assert.throws(() => svc.reassign(id, 0, 'alice', 'eve'));
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('边界：50 字段仅普通层，51 字段两层；同一人可参与不同层', () => {
  const { svc, dir } = makeService();
  try {
    const id50 = svc.submit({ initiator: 'root', fieldCount: 50, normalApprovers: ['alice'] });
    assert.equal(svc.getInstance(id50).layers.length, 1);

    const id51 = svc.submit({ initiator: 'root', fieldCount: 51, normalApprovers: ['alice'], seniorApprovers: ['alice', 'bob'] });
    const inst = svc.getInstance(id51);
    assert.equal(inst.layers.length, 2);
    svc.act({ todoId: todoOf(svc, 'alice', id51), operator: 'alice', action: 'approve' });
    // alice 在高级层重新获得待办
    assert.equal(svc.listTodos('alice').filter((t) => t.instanceId === id51).length, 1);
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('校验：不能办理他人待办；不能修改未来层；重复提交参数校验', () => {
  const { svc, dir } = makeService();
  try {
    const id = svc.submit({ initiator: 'root', fieldCount: 60, normalApprovers: ['alice'], seniorApprovers: ['carol'] });
    const aliceTodo = todoOf(svc, 'alice', id);
    assert.throws(() => svc.act({ todoId: aliceTodo, operator: 'mallory', action: 'approve' }));
    assert.throws(() => svc.addApprover(id, 1, 'eve')); // 未来层
    assert.throws(() => svc.reassign(id, 1, 'carol', 'eve')); // 未来层
    assert.throws(() => svc.submit({ initiator: 'root', fieldCount: 60, normalApprovers: ['alice'] })); // 缺高级层名单
    assert.throws(() => svc.submit({ initiator: 'root', fieldCount: 10, normalApprovers: [] }));
  } finally {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('持久化：状态存入 SQLite，重开后可继续办理', () => {
  const { svc, dir, dbPath } = makeService();
  const id = svc.submit({ initiator: 'root', fieldCount: 60, normalApprovers: ['alice'], seniorApprovers: ['carol'] });
  svc.act({ todoId: todoOf(svc, 'alice', id), operator: 'alice', action: 'approve' });
  svc.close();

  const svc2 = new ApprovalService(dbPath);
  try {
    const inst = svc2.getInstance(id);
    assert.equal(inst.layers[0].status, 'completed');
    assert.equal(inst.layers[1].status, 'active');
    svc2.act({ todoId: todoOf(svc2, 'carol', id), operator: 'carol', action: 'approve' });
    assert.equal(svc2.getInstance(id).status, 'approved');
  } finally {
    svc2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
