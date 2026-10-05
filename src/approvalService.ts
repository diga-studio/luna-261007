import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./db.ts";
import { ApprovalError } from "./errors.ts";
import type { InstanceView, SubmitInput, TodoView } from "./types.ts";
import type { InstanceStatus, LayerType } from "./types.ts";

const FIELD_COUNT_THRESHOLD = 50;

interface InstanceRow {
  id: string;
  initiator: string;
  field_count: number;
  status: string;
  current_layer: number;
}

function now(): string {
  return new Date().toISOString();
}

function dedupe(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * ForgeKit 本地审批流服务。操作者身份由上层业务核实，
 * 本库只校验操作者与待办/实例的关系。
 */
export class ApprovalService {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  /** 提交审批实例，返回实例 id。路径在提交时固定。 */
  submit(input: SubmitInput): string {
    const initiator = input.initiator?.trim();
    if (!initiator) {
      throw new ApprovalError("INVALID_INPUT", "initiator 不能为空");
    }
    if (!Number.isInteger(input.fieldCount) || input.fieldCount < 1) {
      throw new ApprovalError("INVALID_INPUT", "fieldCount 必须为正整数");
    }
    const normalApprovers = dedupe((input.normalApprovers ?? []).map((n) => n.trim()).filter(Boolean));
    if (normalApprovers.length === 0) {
      throw new ApprovalError("INVALID_INPUT", "普通层审批人名单不能为空");
    }
    const needSenior = input.fieldCount > FIELD_COUNT_THRESHOLD;
    const seniorApprovers = dedupe((input.seniorApprovers ?? []).map((n) => n.trim()).filter(Boolean));
    if (needSenior && seniorApprovers.length === 0) {
      throw new ApprovalError("INVALID_INPUT", "变更字段数超过 50 时必须提供高级层审批人名单");
    }

    const id = randomUUID();
    const layers: Array<{ type: LayerType; approvers: string[] }> = [
      { type: "normal", approvers: normalApprovers },
    ];
    if (needSenior) {
      layers.push({ type: "senior", approvers: seniorApprovers });
    }

    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO instances (id, initiator, field_count, status, current_layer, created_at) VALUES (?, ?, ?, 'pending', 0, ?)",
        )
        .run(id, initiator, input.fieldCount, now());
      const insertLayer = this.db.prepare(
        "INSERT INTO layers (instance_id, layer_index, layer_type) VALUES (?, ?, ?)",
      );
      const insertApprover = this.db.prepare(
        "INSERT INTO layer_approvers (instance_id, layer_index, approver) VALUES (?, ?, ?)",
      );
      layers.forEach((layer, index) => {
        insertLayer.run(id, index, layer.type);
        for (const approver of layer.approvers) {
          insertApprover.run(id, index, approver);
        }
      });
      this.createTodos(id, 0, layers[0].approvers);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return id;
  }

  /** 为指定层的审批人生成新的有效待办（每次调用都生成全新 id）。 */
  private createTodos(instanceId: string, layerIndex: number, assignees: string[]): void {
    const insert = this.db.prepare(
      "INSERT INTO todos (id, instance_id, layer_index, assignee, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    );
    for (const assignee of assignees) {
      insert.run(randomUUID(), instanceId, layerIndex, assignee, now());
    }
  }

  private getInstanceRow(instanceId: string): InstanceRow {
    const row = this.db.prepare("SELECT * FROM instances WHERE id = ?").get(instanceId) as
      | InstanceRow
      | undefined;
    if (!row) {
      throw new ApprovalError("INSTANCE_NOT_FOUND", `实例不存在: ${instanceId}`);
    }
    return row;
  }

  /** 对操作者当前有效待办办理同意。 */
  approve(todoId: string, operator: string): void {
    this.db.exec("BEGIN");
    try {
      const { instance, todo } = this.loadActionableTodo(todoId, operator);
      this.db
        .prepare(
          "INSERT INTO consents (instance_id, layer_index, approver, decided_at) VALUES (?, ?, ?, ?)",
        )
        .run(instance.id, todo.layer_index, operator, now());
      this.db.prepare("UPDATE todos SET status = 'done' WHERE id = ?").run(todoId);
      if (this.isLayerComplete(instance.id, todo.layer_index)) {
        this.advanceLayer(instance, todo.layer_index);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 对操作者当前有效待办办理驳回，实例终结为驳回。 */
  reject(todoId: string, operator: string): void {
    this.db.exec("BEGIN");
    try {
      const { instance } = this.loadActionableTodo(todoId, operator);
      this.terminate(instance.id, "rejected");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 发起人撤回，实例终结为撤回。 */
  withdraw(instanceId: string, operator: string): void {
    this.db.exec("BEGIN");
    try {
      const instance = this.getInstanceRow(instanceId);
      this.assertPending(instance);
      if (instance.initiator !== operator) {
        throw new ApprovalError("NOT_INITIATOR", "只有发起人可以撤回实例");
      }
      this.terminate(instanceId, "withdrawn");
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * 加载一条可供 operator 办理的有效待办及其所属实例。
   * 已办理或已失效的待办直接抛错，不会改变实例。
   */
  private loadActionableTodo(
    todoId: string,
    operator: string,
  ): { instance: InstanceRow; todo: { id: string; layer_index: number; assignee: string } } {
    const todo = this.db
      .prepare("SELECT id, instance_id, layer_index, assignee, status FROM todos WHERE id = ?")
      .get(todoId) as
      | { id: string; instance_id: string; layer_index: number; assignee: string; status: string }
      | undefined;
    if (!todo) {
      throw new ApprovalError("TODO_NOT_FOUND", `待办不存在: ${todoId}`);
    }
    if (todo.status !== "active") {
      throw new ApprovalError("TODO_NOT_ACTIVE", "待办已办理或已失效，不能再次办理");
    }
    if (todo.assignee !== operator) {
      throw new ApprovalError("TODO_NOT_ASSIGNEE", "只能办理本人名下的待办");
    }
    const instance = this.getInstanceRow(todo.instance_id);
    this.assertPending(instance);
    if (instance.current_layer !== todo.layer_index) {
      throw new ApprovalError("TODO_NOT_ACTIVE", "该待办不属于当前审批层，已失效");
    }
    return { instance, todo };
  }

  private assertPending(instance: InstanceRow): void {
    if (instance.status !== "pending") {
      throw new ApprovalError("INSTANCE_NOT_PENDING", `实例已终结（${instance.status}），不能再操作`);
    }
  }

  /** 判断指定层是否全员同意。 */
  private isLayerComplete(instanceId: string, layerIndex: number): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS missing FROM layer_approvers a
         WHERE a.instance_id = ? AND a.layer_index = ?
           AND NOT EXISTS (
             SELECT 1 FROM consents c
             WHERE c.instance_id = a.instance_id AND c.layer_index = a.layer_index AND c.approver = a.approver
           )`,
      )
      .get(instanceId, layerIndex) as { missing: number };
    return Number(row.missing) === 0;
  }

  /** 当前层完成后推进：还有后续层则为下一层生成待办，否则实例通过。 */
  private advanceLayer(instance: InstanceRow, finishedLayer: number): void {
    const next = this.db
      .prepare("SELECT layer_index FROM layers WHERE instance_id = ? AND layer_index > ? ORDER BY layer_index LIMIT 1")
      .get(instance.id, finishedLayer) as { layer_index: number } | undefined;
    if (!next) {
      this.terminate(instance.id, "approved");
      return;
    }
    this.db
      .prepare("UPDATE instances SET current_layer = ? WHERE id = ?")
      .run(next.layer_index, instance.id);
    const approvers = this.db
      .prepare("SELECT approver FROM layer_approvers WHERE instance_id = ? AND layer_index = ?")
      .all(instance.id, next.layer_index) as Array<{ approver: string }>;
    this.createTodos(instance.id, next.layer_index, approvers.map((a) => a.approver));
  }

  /** 终结实例：写入终态并作废所有有效待办。 */
  private terminate(instanceId: string, status: "approved" | "rejected" | "withdrawn"): void {
    this.db.prepare("UPDATE instances SET status = ? WHERE id = ?").run(status, instanceId);
    this.db
      .prepare("UPDATE todos SET status = 'invalid' WHERE instance_id = ? AND status = 'active'")
      .run(instanceId);
  }

  /** 加签：在指定层（当前层或已完成层）增加审批人。 */
  addSign(instanceId: string, layerIndex: number, approvers: string[]): void {
    this.db.exec("BEGIN");
    try {
      const instance = this.getInstanceRow(instanceId);
      this.assertPending(instance);
      this.assertLayerEditable(instance, layerIndex);
      const existing = this.layerApprovers(instanceId, layerIndex);
      const newcomers = dedupe(approvers.map((n) => n.trim()).filter(Boolean)).filter(
        (n) => !existing.includes(n),
      );
      if (newcomers.length === 0) {
        this.db.exec("COMMIT");
        return;
      }
      const insert = this.db.prepare(
        "INSERT INTO layer_approvers (instance_id, layer_index, approver) VALUES (?, ?, ?)",
      );
      for (const name of newcomers) {
        insert.run(instanceId, layerIndex, name);
      }
      if (layerIndex < instance.current_layer) {
        this.reopenLayer(instance, layerIndex);
      }
      this.createTodos(instanceId, layerIndex, newcomers);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 改派：替换指定层（当前层或已完成层）的一名审批人。 */
  reassign(instanceId: string, layerIndex: number, from: string, to: string): void {
    this.db.exec("BEGIN");
    try {
      const instance = this.getInstanceRow(instanceId);
      this.assertPending(instance);
      this.assertLayerEditable(instance, layerIndex);
      const existing = this.layerApprovers(instanceId, layerIndex);
      if (!existing.includes(from)) {
        throw new ApprovalError("APPROVER_NOT_IN_LAYER", `${from} 不是该层审批人，无法改派`);
      }
      if (existing.includes(to)) {
        throw new ApprovalError("APPROVER_ALREADY_IN_LAYER", `${to} 已在该层审批人名单中`);
      }
      this.db
        .prepare("DELETE FROM layer_approvers WHERE instance_id = ? AND layer_index = ? AND approver = ?")
        .run(instanceId, layerIndex, from);
      this.db
        .prepare("INSERT INTO layer_approvers (instance_id, layer_index, approver) VALUES (?, ?, ?)")
        .run(instanceId, layerIndex, to);
      // 原审批人的既有同意与待办立即失效
      this.db
        .prepare("DELETE FROM consents WHERE instance_id = ? AND layer_index = ? AND approver = ?")
        .run(instanceId, layerIndex, from);
      this.db
        .prepare(
          "UPDATE todos SET status = 'invalid' WHERE instance_id = ? AND layer_index = ? AND assignee = ? AND status = 'active'",
        )
        .run(instanceId, layerIndex, from);
      if (layerIndex < instance.current_layer) {
        this.reopenLayer(instance, layerIndex);
      }
      this.createTodos(instanceId, layerIndex, [to]);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** 校验目标层存在且不是未来层（只允许当前层或已完成层）。 */
  private assertLayerEditable(instance: InstanceRow, layerIndex: number): void {
    const row = this.db
      .prepare("SELECT MIN(layer_index) AS minIdx, MAX(layer_index) AS maxIdx FROM layers WHERE instance_id = ?")
      .get(instance.id) as { minIdx: number; maxIdx: number };
    if (!Number.isInteger(layerIndex) || layerIndex < row.minIdx || layerIndex > row.maxIdx) {
      throw new ApprovalError("LAYER_OUT_OF_RANGE", `层下标越界: ${layerIndex}`);
    }
    if (layerIndex > instance.current_layer) {
      throw new ApprovalError("LAYER_NOT_STARTED", "不能修改尚未开始的未来层");
    }
  }

  private layerApprovers(instanceId: string, layerIndex: number): string[] {
    const rows = this.db
      .prepare("SELECT approver FROM layer_approvers WHERE instance_id = ? AND layer_index = ?")
      .all(instanceId, layerIndex) as Array<{ approver: string }>;
    return rows.map((r) => r.approver);
  }

  /**
   * 实例退回指定层：其后所有层的同意全部作废、已签发待办全部失效，
   * 当前层指针回退到该层，等待其重新完成后再依次推进。
   */
  private reopenLayer(instance: InstanceRow, layerIndex: number): void {
    this.db
      .prepare("DELETE FROM consents WHERE instance_id = ? AND layer_index > ?")
      .run(instance.id, layerIndex);
    this.db
      .prepare("UPDATE todos SET status = 'invalid' WHERE instance_id = ? AND status = 'active'")
      .run(instance.id);
    this.db
      .prepare("UPDATE instances SET current_layer = ? WHERE id = ?")
      .run(layerIndex, instance.id);
  }

  /** 查看实例。 */
  getInstance(instanceId: string): InstanceView {
    const row = this.getInstanceRow(instanceId);
    const layerRows = this.db
      .prepare("SELECT layer_index, layer_type FROM layers WHERE instance_id = ? ORDER BY layer_index")
      .all(instanceId) as Array<{ layer_index: number; layer_type: string }>;
    const approverStmt = this.db.prepare(
      "SELECT approver FROM layer_approvers WHERE instance_id = ? AND layer_index = ? ORDER BY approver",
    );
    const consentStmt = this.db.prepare(
      "SELECT approver FROM consents WHERE instance_id = ? AND layer_index = ? ORDER BY approver",
    );
    const layers = layerRows.map((layer) => {
      const approvers = (approverStmt.all(instanceId, layer.layer_index) as Array<{ approver: string }>).map(
        (r) => r.approver,
      );
      const consented = (consentStmt.all(instanceId, layer.layer_index) as Array<{ approver: string }>).map(
        (r) => r.approver,
      );
      const consentedSet = new Set(consented);
      return {
        index: layer.layer_index,
        type: layer.layer_type as LayerType,
        approvers,
        consented,
        completed: approvers.length > 0 && approvers.every((a) => consentedSet.has(a)),
      };
    });
    const status = row.status as InstanceStatus;
    return {
      id: row.id,
      initiator: row.initiator,
      fieldCount: row.field_count,
      status,
      currentLayerIndex: status === "pending" ? row.current_layer : null,
      layers,
    };
  }

  /** 查询某人当前能办理的待办。 */
  listTodos(assignee: string): TodoView[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.instance_id, t.layer_index, t.assignee
         FROM todos t JOIN instances i ON i.id = t.instance_id
         WHERE t.assignee = ? AND t.status = 'active' AND i.status = 'pending'
         ORDER BY t.created_at, t.id`,
      )
      .all(assignee) as Array<{ id: string; instance_id: string; layer_index: number; assignee: string }>;
    return rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      layerIndex: r.layer_index,
      assignee: r.assignee,
    }));
  }

  /** 关闭底层数据库连接。 */
  close(): void {
    this.db.close();
  }
}
