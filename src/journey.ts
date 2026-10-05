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
  private readonly declared = new Map<TaskId, boolean>();

  constructor(tasks: TaskSpec[]) {
    const specs = new Map<TaskId, TaskSpec>();
    for (const task of tasks) {
      if (specs.has(task.id)) {
        throw new Error(`duplicate task id: ${task.id}`);
      }
      specs.set(task.id, { id: task.id, prerequisites: [...task.prerequisites] });
    }
    for (const task of specs.values()) {
      for (const prereq of task.prerequisites) {
        if (!specs.has(prereq)) {
          throw new Error(`task ${task.id} depends on unknown task: ${prereq}`);
        }
      }
    }
    this.tasks = specs;
    for (const id of specs.keys()) {
      this.declared.set(id, false);
    }
  }

  private isEffectivelyCompleted(id: TaskId, memo: Map<TaskId, boolean>): boolean {
    const cached = memo.get(id);
    if (cached !== undefined) {
      return cached;
    }
    memo.set(id, false);
    const spec = this.tasks.get(id)!;
    let result = this.declared.get(id)!;
    if (result) {
      for (const prereq of spec.prerequisites) {
        if (!this.isEffectivelyCompleted(prereq, memo)) {
          result = false;
          break;
        }
      }
    }
    memo.set(id, result);
    return result;
  }

  private visibleStates(): Map<TaskId, VisibleState> {
    const memo = new Map<TaskId, boolean>();
    const states = new Map<TaskId, VisibleState>();
    for (const [id, spec] of this.tasks) {
      let locked = false;
      for (const prereq of spec.prerequisites) {
        if (!this.isEffectivelyCompleted(prereq, memo)) {
          locked = true;
          break;
        }
      }
      if (locked) {
        states.set(id, "locked");
      } else {
        states.set(id, this.declared.get(id)! ? "completed" : "ready");
      }
    }
    return states;
  }

  applyBatch(changes: Readonly<Record<TaskId, boolean>>): StateChange[] {
    for (const id of Object.keys(changes)) {
      if (!this.tasks.has(id)) {
        throw new Error(`unknown task id: ${id}`);
      }
    }
    const before = this.visibleStates();
    for (const [id, value] of Object.entries(changes)) {
      this.declared.set(id, value);
    }
    const after = this.visibleStates();
    const diff: StateChange[] = [];
    for (const id of this.tasks.keys()) {
      const from = before.get(id)!;
      const to = after.get(id)!;
      if (from !== to) {
        diff.push({ id, from, to });
      }
    }
    return diff;
  }
}

export function createJourney(tasks: TaskSpec[]): Journey {
  return new Journey(tasks);
}

export function applyCompletions(
  journey: Journey,
  changes: Readonly<Record<TaskId, boolean>>
): StateChange[] {
  return journey.applyBatch(changes);
}
