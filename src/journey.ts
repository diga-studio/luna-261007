export type TaskId = string;

export type VisibleState = "locked" | "ready" | "completed";

export interface TaskSpec {
  id: TaskId;
  prerequisites: TaskId[];
}

export interface StateChange {
  id: TaskId;
  from: VisibleState;
  to: VisibleState;
}

export class Journey {
  readonly tasks: ReadonlyMap<TaskId, TaskSpec>;
  private readonly order: TaskId[];
  private readonly declared = new Map<TaskId, boolean>();
  private readonly effective = new Map<TaskId, boolean>();

  constructor(specs: TaskSpec[]) {
    const tasks = new Map<TaskId, TaskSpec>();
    for (const spec of specs) {
      if (tasks.has(spec.id)) {
        throw new Error(`duplicate task id: ${spec.id}`);
      }
      tasks.set(spec.id, { id: spec.id, prerequisites: [...spec.prerequisites] });
    }
    for (const spec of tasks.values()) {
      for (const prereq of spec.prerequisites) {
        if (!tasks.has(prereq)) {
          throw new Error(`task ${spec.id} has unknown prerequisite: ${prereq}`);
        }
      }
    }
    this.tasks = tasks;
    this.order = topologicalOrder(tasks);
    for (const id of this.order) {
      this.declared.set(id, false);
      this.effective.set(id, false);
    }
    this.recompute();
  }

  private recompute(): void {
    for (const id of this.order) {
      const spec = this.tasks.get(id)!;
      const prereqsDone = spec.prerequisites.every((p) => this.effective.get(p)!);
      this.effective.set(id, this.declared.get(id)! && prereqsDone);
    }
  }

  stateOf(id: TaskId): VisibleState {
    const spec = this.tasks.get(id);
    if (!spec) {
      throw new Error(`unknown task id: ${id}`);
    }
    const prereqsDone = spec.prerequisites.every((p) => this.effective.get(p)!);
    if (!prereqsDone) {
      return "locked";
    }
    return this.declared.get(id)! ? "completed" : "ready";
  }

  apply(changes: Readonly<Record<TaskId, boolean>>): StateChange[] {
    for (const id of Object.keys(changes)) {
      if (!this.tasks.has(id)) {
        throw new Error(`unknown task id: ${id}`);
      }
    }
    const before = new Map<TaskId, VisibleState>();
    for (const id of this.order) {
      before.set(id, this.stateOf(id));
    }
    for (const [id, value] of Object.entries(changes)) {
      this.declared.set(id, value);
    }
    this.recompute();
    const diff: StateChange[] = [];
    for (const id of this.order) {
      const from = before.get(id)!;
      const to = this.stateOf(id);
      if (from !== to) {
        diff.push({ id, from, to });
      }
    }
    return diff;
  }
}

function topologicalOrder(tasks: ReadonlyMap<TaskId, TaskSpec>): TaskId[] {
  const indegree = new Map<TaskId, number>();
  const dependents = new Map<TaskId, TaskId[]>();
  for (const spec of tasks.values()) {
    indegree.set(spec.id, spec.prerequisites.length);
    for (const prereq of spec.prerequisites) {
      const list = dependents.get(prereq);
      if (list) {
        list.push(spec.id);
      } else {
        dependents.set(prereq, [spec.id]);
      }
    }
  }
  const queue: TaskId[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }
  const order: TaskId[] = [];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const degree = indegree.get(dependent)! - 1;
      indegree.set(dependent, degree);
      if (degree === 0) {
        queue.push(dependent);
      }
    }
  }
  if (order.length !== tasks.size) {
    throw new Error("task graph contains a cycle");
  }
  return order;
}

export function createJourney(tasks: TaskSpec[]): Journey {
  return new Journey(tasks);
}

export function applyCompletions(
  journey: Journey,
  changes: Readonly<Record<TaskId, boolean>>
): StateChange[] {
  return journey.apply(changes);
}

export function visibleState(journey: Journey, id: TaskId): VisibleState {
  return journey.stateOf(id);
}
