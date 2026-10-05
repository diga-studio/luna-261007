import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalError, ApprovalService } from "../src/index.ts";
import type { TodoView } from "../src/index.ts";

function newService(): ApprovalService {
  return new ApprovalService(":memory:");
}

/** 取出某人当前唯一待办；数量不符时直接断言失败。 */
function onlyTodo(svc: ApprovalService, assignee: string): TodoView {
  const todos = svc.listTodos(assignee);
  assert.equal(todos.length, 1, `期望 ${assignee} 恰有 1 条待办，实际 ${todos.length} 条`);
  return todos[0];
}

function todoIds(svc: ApprovalService, assignee: string): string[] {
  return svc.listTodos(assignee).map((t) => t.id);
}

function assertErrorCode(fn: () => void, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof ApprovalError && err.code === code);
}

test("单层流程：字段数不超过 50 只走普通层，全员同意后通过", () => {
  const svc = newService();
  const id = svc.submit({ initiator: "ivy", fieldCount: 30, normalApprovers: ["a", "b"] });

  let inst = svc.getInstance(id);
  assert.equal(inst.status, "pending");
  assert.equal(inst.layers.length, 1);
  assert.equal(inst.layers[0].type, "normal");
  assert.equal(inst.currentLayerIndex, 0);

  // 两人的待办同时有效
  assert.equal(todoIds(svc, "a").length, 1);
  assert.equal(todoIds(svc, "b").length, 1);

  svc.approve(onlyTodo(svc, "a").id, "a");
  inst = svc.getInstance(id);
  assert.equal(inst.status, "pending");
  assert.deepEqual(inst.layers[0].consented, ["a"]);
  assert.equal(inst.layers[0].completed, false);

  svc.approve(onlyTodo(svc, "b").id, "b");
  inst = svc.getInstance(id);
  assert.equal(inst.status, "approved");
  assert.equal(inst.currentLayerIndex, null);
  assert.equal(inst.layers[0].completed, true);

  // 终态后没有任何有效待办
  assert.equal(todoIds(svc, "a").length, 0);
  assert.equal(todoIds(svc, "b").length, 0);
  svc.close();
});

test("双层流程：仅当前最早未完成层产生有效待办，后续层不得提前办理", () => {
  const svc = newService();
  const id = svc.submit({
    initiator: "ivy",
    fieldCount: 80,
    normalApprovers: ["a", "b"],
    seniorApprovers: ["c", "d"],
  });

  const inst = svc.getInstance(id);
  assert.equal(inst.layers.length, 2);
  assert.deepEqual(
    inst.layers.map((l) => l.type),
    ["normal", "senior"],
  );

  // 高级层审批人此时没有待办，无法提前办理
  assert.equal(todoIds(svc, "c").length, 0);
  assert.equal(todoIds(svc, "d").length, 0);

  svc.approve(onlyTodo(svc, "a").id, "a");
  // 普通层未全员同意，高级层仍无待办
  assert.equal(todoIds(svc, "c").length, 0);

  svc.approve(onlyTodo(svc, "b").id, "b");
  // 普通层完成，高级层待办出现
  assert.equal(todoIds(svc, "a").length, 0);
  assert.equal(todoIds(svc, "b").length, 0);
  assert.equal(todoIds(svc, "c").length, 1);
  assert.equal(todoIds(svc, "d").length, 1);
  assert.equal(svc.getInstance(id).currentLayerIndex, 1);

  svc.approve(onlyTodo(svc, "c").id, "c");
  svc.approve(onlyTodo(svc, "d").id, "d");
  assert.equal(svc.getInstance(id).status, "approved");
  svc.close();
});

test("同一人可以参与不同层，逐层办理", () => {
  const svc = newService();
  const id = svc.submit({
    initiator: "ivy",
    fieldCount: 99,
    normalApprovers: ["a"],
    seniorApprovers: ["a"],
  });

  const first = onlyTodo(svc, "a");
  assert.equal(first.layerIndex, 0);
  svc.approve(first.id, "a");

  const second = onlyTodo(svc, "a");
  assert.equal(second.layerIndex, 1);
  assert.notEqual(second.id, first.id);
  svc.approve(second.id, "a");

  assert.equal(svc.getInstance(id).status, "approved");
  svc.close();
});

test("已办理过的待办再次提交不改变实例", () => {
  const svc = newService();
  const id = svc.submit({ initiator: "ivy", fieldCount: 10, normalApprovers: ["a", "b"] });

  const todoA = onlyTodo(svc, "a");
  svc.approve(todoA.id, "a");
  const before = svc.getInstance(id);

  assertErrorCode(() => svc.approve(todoA.id, "a"), "TODO_NOT_ACTIVE");
  assertErrorCode(() => svc.reject(todoA.id, "a"), "TODO_NOT_ACTIVE");
  assert.deepEqual(svc.getInstance(id), before);
  svc.close();
});

test("不能办理他人待办", () => {
  const svc = newService();
  svc.submit({ initiator: "ivy", fieldCount: 10, normalApprovers: ["a"] });
  const todo = onlyTodo(svc, "a");
  assertErrorCode(() => svc.approve(todo.id, "b"), "TODO_NOT_ASSIGNEE");
  svc.close();
});

test("驳回：任一有效驳回使实例终结，其余待办全部失效且不能再办理", () => {
  const svc = newService();
  const id = svc.submit({
    initiator: "ivy",
    fieldCount: 60,
    normalApprovers: ["a", "b"],
    seniorApprovers: ["c"],
  });

  const todoA = onlyTodo(svc, "a");
  const todoB = onlyTodo(svc, "b");
  svc.reject(todoA.id, "a");

  const inst = svc.getInstance(id);
  assert.equal(inst.status, "rejected");
  assert.equal(inst.currentLayerIndex, null);

  // 所有待办失效，任何旧待办都不能改变终态
  assert.equal(todoIds(svc, "a").length, 0);
  assert.equal(todoIds(svc, "b").length, 0);
  assertErrorCode(() => svc.approve(todoB.id, "b"), "TODO_NOT_ACTIVE");
  assertErrorCode(() => svc.reject(todoB.id, "b"), "TODO_NOT_ACTIVE");
  assert.equal(svc.getInstance(id).status, "rejected");

  // 终态后不能撤回、加签、改派
  assertErrorCode(() => svc.withdraw(id, "ivy"), "INSTANCE_NOT_PENDING");
  assertErrorCode(() => svc.addSign(id, 0, ["x"]), "INSTANCE_NOT_PENDING");
  assertErrorCode(() => svc.reassign(id, 0, "b", "x"), "INSTANCE_NOT_PENDING");
  svc.close();
});

test("撤回：仅发起人可撤回，撤回后没有有效待办且不能改变终态", () => {
  const svc = newService();
  const id = svc.submit({ initiator: "ivy", fieldCount: 10, normalApprovers: ["a", "b"] });

  assertErrorCode(() => svc.withdraw(id, "a"), "NOT_INITIATOR");

  const todoA = onlyTodo(svc, "a");
  svc.withdraw(id, "ivy");
  assert.equal(svc.getInstance(id).status, "withdrawn");

  assert.equal(todoIds(svc, "a").length, 0);
  assert.equal(todoIds(svc, "b").length, 0);
  assertErrorCode(() => svc.approve(todoA.id, "a"), "TODO_NOT_ACTIVE");
  assertErrorCode(() => svc.withdraw(id, "ivy"), "INSTANCE_NOT_PENDING");
  assertErrorCode(() => svc.addSign(id, 0, ["x"]), "INSTANCE_NOT_PENDING");
  assert.equal(svc.getInstance(id).status, "withdrawn");
  svc.close();
});

test("通过后没有有效待办，旧待办与后续操作都不能改变终态", () => {
  const svc = newService();
  const id = svc.submit({ initiator: "ivy", fieldCount: 10, normalApprovers: ["a"] });

  const todo = onlyTodo(svc, "a");
  svc.approve(todo.id, "a");
  assert.equal(svc.getInstance(id).status, "approved");

  assert.equal(todoIds(svc, "a").length, 0);
  assertErrorCode(() => svc.approve(todo.id, "a"), "TODO_NOT_ACTIVE");
  assertErrorCode(() => svc.reject(todo.id, "a"), "TODO_NOT_ACTIVE");
  assertErrorCode(() => svc.withdraw(id, "ivy"), "INSTANCE_NOT_PENDING");
  assertErrorCode(() => svc.addSign(id, 0, ["x"]), "INSTANCE_NOT_PENDING");
  assertErrorCode(() => svc.reassign(id, 0, "a", "x"), "INSTANCE_NOT_PENDING");
  assert.equal(svc.getInstance(id).status, "approved");
  svc.close();
});

test("持久化：状态写入 SQLite 文件，重开后完整保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "forgekit-approval-"));
  const file = join(dir, "approval.db");
  try {
    const svc1 = new ApprovalService(file);
    const id = svc1.submit({ initiator: "ivy", fieldCount: 10, normalApprovers: ["a", "b"] });
    svc1.approve(onlyTodo(svc1, "a").id, "a");
    svc1.close();

    const svc2 = new ApprovalService(file);
    const inst = svc2.getInstance(id);
    assert.equal(inst.status, "pending");
    assert.deepEqual(inst.layers[0].consented, ["a"]);
    assert.equal(todoIds(svc2, "b").length, 1);
    svc2.approve(onlyTodo(svc2, "b").id, "b");
    assert.equal(svc2.getInstance(id).status, "approved");
    svc2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("提交参数校验", () => {
  const svc = newService();
  assertErrorCode(
    () => svc.submit({ initiator: "", fieldCount: 10, normalApprovers: ["a"] }),
    "INVALID_INPUT",
  );
  assertErrorCode(
    () => svc.submit({ initiator: "ivy", fieldCount: 0, normalApprovers: ["a"] }),
    "INVALID_INPUT",
  );
  assertErrorCode(
    () => svc.submit({ initiator: "ivy", fieldCount: 10, normalApprovers: [] }),
    "INVALID_INPUT",
  );
  // 超过 50 必须提供高级层
  assertErrorCode(
    () => svc.submit({ initiator: "ivy", fieldCount: 51, normalApprovers: ["a"] }),
    "INVALID_INPUT",
  );
  // 不超过 50 时即使给了高级层名单也只走普通层
  const id = svc.submit({ initiator: "ivy", fieldCount: 50, normalApprovers: ["a"], seniorApprovers: ["c"] });
  assert.equal(svc.getInstance(id).layers.length, 1);
  svc.close();
});
