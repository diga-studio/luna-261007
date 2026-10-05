import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.js';
import type {
  ActInput,
  InstanceStatus,
  InstanceView,
  LayerView,
  SubmitInput,
  TodoView,
} from './types.js';

const FIELD_THRESHOLD = 50;

interface LayerRow {
  id: string;
  instance_id: string;
  seq: number;
  kind: 'normal' | 'senior';
  status: 'pending' | 'active' | 'completed';
}

export class ApprovalService {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  /** 提交审批实例：路径在提交时固定（<=50 仅普通层，>50 普通层+高级层） */
  submit(input: SubmitInput): string {
    const { initiator, fieldCount, normalApprovers, seniorApprovers } = input;
    if (!initiator) throw new Error('initiator is required');
    if (!Number.isInteger(fieldCount) || fieldCount < 0) throw new Error('invalid fieldCount');
    if (!normalApprovers || normalApprovers.length === 0) {
      throw new Error('normalApprovers must not be empty');
    }
    const needsSenior = fieldCount > FIELD_THRESHOLD;
    if (needsSenior && (!seniorApprovers || seniorApprovers.length === 0)) {
      throw new Error('seniorApprovers is required when fieldCount > 50');
    }

    const instanceId = randomUUID();
    const now = Date.now();
    this.tx(() => {
      this.db
        .prepare(
          'INSERT INTO instances (id, initiator, field_count, status, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(instanceId, initiator, fieldCount, 'active', now);
      this.insertLayer(instanceId, 0, 'normal', 'active', normalApprovers, now);
      if (needsSenior) {
        this.insertLayer(instanceId, 1, 'senior', 'pending', seniorApprovers!, now);
      }
    });
    return instanceId;
  }

  /** 办理审批动作：同意或驳回，必须针对操作者当前有效待办 */
  act(input: ActInput): void {
    const { todoId, operator, action } = input;
    this.tx(() => {
      const todo = this.db
        .prepare('SELECT id, instance_id, layer_id, assignee, status FROM todos WHERE id = ?')
        .get(todoId) as
        | { id: string; instance_id: string; layer_id: string; assignee: string; status: string }
        | undefined;
      if (!todo) throw new Error(`todo not found: ${todoId}`);
      // 已办理或已失效的待办再次提交：不改变实例
      if (todo.status !== 'open') return;
      if (todo.assignee !== operator) {
        throw new Error(`todo ${todoId} does not belong to operator ${operator}`);
      }
      const instance = this.mustInstance(todo.instance_id);
      if (instance.status !== 'active') return; // 防御：终态不应存在有效待办
      const layer = this.mustLayer(todo.layer_id);
      if (layer.status !== 'active') return; // 防御：只有当前层产生有效待办

      this.db.prepare("UPDATE todos SET status = 'done' WHERE id = ?").run(todoId);

      if (action === 'reject') {
        // 任一有效驳回使实例终结为驳回
        this.db.prepare("UPDATE instances SET status = 'rejected' WHERE id = ?").run(todo.instance_id);
        this.invalidateOpenTodos(todo.instance_id);
        return;
      }

      // 同意：记录该审批人的决定
      this.db
        .prepare(
          "UPDATE assignees SET decision = 'approved', decided_at = ? WHERE layer_id = ? AND person = ? AND active = 1",
        )
        .run(Date.now(), todo.layer_id, operator);

      // 该层全员同意才算完成
      const remaining = this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM assignees WHERE layer_id = ? AND active = 1 AND (decision IS NULL OR decision != 'approved')",
        )
        .get(todo.layer_id) as { n: number };
      if (remaining.n > 0) return;

      this.db.prepare("UPDATE layers SET status = 'completed' WHERE id = ?").run(todo.layer_id);
      const next = this.db
        .prepare('SELECT id FROM layers WHERE instance_id = ? AND seq = ?')
        .get(todo.instance_id, layer.seq + 1) as { id: string } | undefined;
      if (next) {
        this.activateLayer(next.id);
      } else {
        // 最后一层完成，实例终结为通过
        this.db.prepare("UPDATE instances SET status = 'approved' WHERE id = ?").run(todo.instance_id);
        this.invalidateOpenTodos(todo.instance_id);
      }
    });
  }

  /** 加签：在指定层（当前层或已完成层）增加审批人 */
  addApprover(instanceId: string, layerSeq: number, person: string): void {
    if (!person) throw new Error('person is required');
    this.tx(() => {
      const layer = this.mustMutableLayer(instanceId, layerSeq);
      this.assertNotAssignee(layer.id, person);
      this.insertAssignee(layer.id, person, Date.now());
      if (layer.status === 'completed') this.rollbackToLayer(layer);
    });
  }

  /** 改派：替换指定层（当前层或已完成层）的一名审批人 */
  reassign(instanceId: string, layerSeq: number, fromPerson: string, toPerson: string): void {
    if (!toPerson) throw new Error('toPerson is required');
    this.tx(() => {
      const layer = this.mustMutableLayer(instanceId, layerSeq);
      const existing = this.db
        .prepare('SELECT id FROM assignees WHERE layer_id = ? AND person = ? AND active = 1')
        .get(layer.id, fromPerson) as { id: string } | undefined;
      if (!existing) throw new Error(`${fromPerson} is not an approver of layer ${layerSeq}`);
      this.assertNotAssignee(layer.id, toPerson);

      // 原审批人的待办与同意失效
      this.db.prepare('UPDATE assignees SET active = 0, decision = NULL, decided_at = NULL WHERE id = ?').run(existing.id);
      this.db
        .prepare("UPDATE todos SET status = 'invalid' WHERE layer_id = ? AND assignee = ? AND status = 'open'")
        .run(layer.id, fromPerson);

      this.insertAssignee(layer.id, toPerson, Date.now());
      if (layer.status === 'completed') this.rollbackToLayer(layer);
    });
  }

  /** 撤回：仅发起人，实例终结为撤回 */
  withdraw(instanceId: string, operator: string): void {
    this.tx(() => {
      const instance = this.mustInstance(instanceId);
      if (instance.status !== 'active') throw new Error(`instance ${instanceId} is already terminal`);
      if (instance.initiator !== operator) throw new Error('only the initiator can withdraw');
      this.db.prepare("UPDATE instances SET status = 'withdrawn' WHERE id = ?").run(instanceId);
      this.invalidateOpenTodos(instanceId);
    });
  }

  getInstance(instanceId: string): InstanceView {
    const instance = this.mustInstance(instanceId);
    const layers = this.db
      .prepare('SELECT id, seq, kind, status FROM layers WHERE instance_id = ? ORDER BY seq')
      .all(instanceId) as unknown as LayerRow[];
    const layerViews: LayerView[] = layers.map((layer) => {
      const assignees = this.db
        .prepare('SELECT person, decision FROM assignees WHERE layer_id = ? AND active = 1 ORDER BY rowid')
        .all(layer.id) as unknown as { person: string; decision: string | null }[];
      return {
        seq: layer.seq,
        kind: layer.kind,
        status: layer.status,
        approvers: assignees.map((a) => ({ person: a.person, approved: a.decision === 'approved' })),
      };
    });
    return {
      id: instance.id,
      initiator: instance.initiator,
      fieldCount: instance.field_count,
      status: instance.status as InstanceStatus,
      layers: layerViews,
    };
  }

  /** 个人当前待办：恰好包含该人现在能办理的事项 */
  listTodos(person: string): TodoView[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.instance_id, t.assignee, t.status, l.seq, l.kind
         FROM todos t JOIN layers l ON l.id = t.layer_id
         WHERE t.assignee = ? AND t.status = 'open'
         ORDER BY t.created_at, t.rowid`,
      )
      .all(person) as unknown as {
      id: string;
      instance_id: string;
      assignee: string;
      status: string;
      seq: number;
      kind: 'normal' | 'senior';
    }[];
    return rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      layerSeq: r.seq,
      kind: r.kind,
      assignee: r.assignee,
      status: r.status as TodoView['status'],
    }));
  }

  // ---- 内部辅助 ----

  private tx(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private insertLayer(
    instanceId: string,
    seq: number,
    kind: 'normal' | 'senior',
    status: 'pending' | 'active',
    people: string[],
    now: number,
  ): void {
    const layerId = randomUUID();
    this.db
      .prepare('INSERT INTO layers (id, instance_id, seq, kind, status) VALUES (?, ?, ?, ?, ?)')
      .run(layerId, instanceId, seq, kind, status);
    for (const person of people) {
      this.insertAssignee(layerId, person, now, status === 'active');
    }
  }

  private insertAssignee(layerId: string, person: string, now: number, withTodo = true): void {
    this.db
      .prepare('INSERT INTO assignees (id, layer_id, person, active, decision, decided_at) VALUES (?, ?, ?, 1, NULL, NULL)')
      .run(randomUUID(), layerId, person);
    if (withTodo) {
      const layer = this.mustLayer(layerId);
      this.db
        .prepare('INSERT INTO todos (id, instance_id, layer_id, assignee, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), layer.instance_id, layerId, person, 'open', now);
    }
  }

  private activateLayer(layerId: string): void {
    this.db.prepare("UPDATE layers SET status = 'active' WHERE id = ?").run(layerId);
    const layer = this.mustLayer(layerId);
    const assignees = this.db
      .prepare('SELECT person FROM assignees WHERE layer_id = ? AND active = 1')
      .all(layerId) as unknown as { person: string }[];
    const now = Date.now();
    for (const a of assignees) {
      this.db
        .prepare('INSERT INTO todos (id, instance_id, layer_id, assignee, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), layer.instance_id, layerId, a.person, 'open', now);
    }
  }

  /** 实例退回某层：其后所有层的同意作废、已签发待办失效 */
  private rollbackToLayer(layer: LayerRow): void {
    this.db.prepare("UPDATE layers SET status = 'active' WHERE id = ?").run(layer.id);
    const later = this.db
      .prepare('SELECT id FROM layers WHERE instance_id = ? AND seq > ?')
      .all(layer.instance_id, layer.seq) as unknown as { id: string }[];
    for (const { id } of later) {
      this.db.prepare("UPDATE layers SET status = 'pending' WHERE id = ?").run(id);
      this.db.prepare('UPDATE assignees SET decision = NULL, decided_at = NULL WHERE layer_id = ?').run(id);
      this.db.prepare("UPDATE todos SET status = 'invalid' WHERE layer_id = ? AND status = 'open'").run(id);
    }
  }

  private invalidateOpenTodos(instanceId: string): void {
    this.db.prepare("UPDATE todos SET status = 'invalid' WHERE instance_id = ? AND status = 'open'").run(instanceId);
  }

  private mustInstance(id: string): { id: string; initiator: string; field_count: number; status: string } {
    const row = this.db
      .prepare('SELECT id, initiator, field_count, status FROM instances WHERE id = ?')
      .get(id) as { id: string; initiator: string; field_count: number; status: string } | undefined;
    if (!row) throw new Error(`instance not found: ${id}`);
    return row;
  }

  private mustLayer(id: string): LayerRow {
    const row = this.db.prepare('SELECT id, instance_id, seq, kind, status FROM layers WHERE id = ?').get(id) as
      | LayerRow
      | undefined;
    if (!row) throw new Error(`layer not found: ${id}`);
    return row;
  }

  /** 加签/改派目标校验：实例未终结，且目标层为当前层或已完成层（不能改未来层） */
  private mustMutableLayer(instanceId: string, layerSeq: number): LayerRow {
    const instance = this.mustInstance(instanceId);
    if (instance.status !== 'active') throw new Error(`instance ${instanceId} is terminal; cannot modify`);
    const row = this.db
      .prepare('SELECT id, instance_id, seq, kind, status FROM layers WHERE instance_id = ? AND seq = ?')
      .get(instanceId, layerSeq) as LayerRow | undefined;
    if (!row) throw new Error(`layer ${layerSeq} not found on instance ${instanceId}`);
    if (row.status === 'pending') throw new Error('cannot modify a future layer');
    return row;
  }

  private assertNotAssignee(layerId: string, person: string): void {
    const dup = this.db
      .prepare('SELECT 1 FROM assignees WHERE layer_id = ? AND person = ? AND active = 1')
      .get(layerId, person);
    if (dup) throw new Error(`${person} is already an approver of this layer`);
  }
}
