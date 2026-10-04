import type {
  HandlerRegistry,
  InstanceStatus,
  JsonValue,
  LoopNodeDef,
  NodeDef,
  RunRecord,
  RunResult,
  RunStatus,
  WorkflowDef,
  EdgeDef,
} from "./types";

type EdgeState = "active" | "inactive";

type NodeStatus = "pending" | "running" | InstanceStatus;

interface ScopeInfo {
  loopId?: string;
  iteration?: number;
}

class RunContext {
  readonly instances: NodeInstance[] = [];
  settled: RunStatus | null = null;
  outerScope!: Scope;
  private readonly timer: unknown;
  private resolveSettled!: () => void;
  private readonly settledPromise: Promise<void>;

  constructor(
    readonly handlers: HandlerRegistry,
    timeoutMs: number,
  ) {
    this.settledPromise = new Promise<void>((resolve) => {
      this.resolveSettled = resolve;
    });
    this.timer = setTimeout(() => this.finish("timeout"), timeoutMs);
  }

  waitSettled(): Promise<void> {
    return this.settledPromise;
  }

  finish(status: RunStatus): void {
    if (this.settled !== null) return;
    this.settled = status;
    clearTimeout(this.timer);
    for (const instance of this.instances) {
      if (instance.status === "pending" || instance.status === "running") {
        instance.status = "cancelled";
      }
    }
    this.resolveSettled();
  }

  buildResult(): RunResult {
    const records: RunRecord[] = this.instances.map((instance) =>
      instance.toRecord(),
    );
    const output: Record<string, JsonValue> = {};
    for (const instance of this.outerScope.nodeInstances()) {
      if (instance.status === "success") {
        output[instance.def.id] = instance.output as JsonValue;
      }
    }
    return { status: this.settled ?? "success", output, records };
  }
}

class Scope {
  private readonly nodes = new Map<string, NodeInstance>();
  private readonly outgoing = new Map<string, EdgeDef[]>();
  private readonly incoming = new Map<string, EdgeDef[]>();
  private terminalCount = 0;
  private readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(
    def: WorkflowDef,
    readonly ctx: RunContext,
    readonly info: ScopeInfo,
  ) {
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    for (const nodeDef of def.nodes) {
      this.nodes.set(nodeDef.id, new NodeInstance(nodeDef, this));
    }
    for (const edge of def.edges) {
      const out = this.outgoing.get(edge.from) ?? [];
      out.push(edge);
      this.outgoing.set(edge.from, out);
      const inc = this.incoming.get(edge.to) ?? [];
      inc.push(edge);
      this.incoming.set(edge.to, inc);
    }
  }

  nodeInstances(): NodeInstance[] {
    return [...this.nodes.values()];
  }

  outgoingEdges(nodeId: string): EdgeDef[] {
    return this.outgoing.get(nodeId) ?? [];
  }

  incomingCount(nodeId: string): number {
    return (this.incoming.get(nodeId) ?? []).length;
  }

  async run(rootInput: JsonValue): Promise<void> {
    if (this.nodes.size === 0) {
      this.resolveDone();
      return;
    }
    for (const node of this.nodes.values()) {
      if (this.incomingCount(node.def.id) === 0) {
        node.startRoot(rootInput);
      }
    }
    await this.done;
  }

  deliver(edge: EdgeDef, state: EdgeState, value?: JsonValue): void {
    if (this.ctx.settled !== null) return;
    const target = this.nodes.get(edge.to);
    if (target) target.onEdge(edge, state, value);
  }

  onNodeTerminal(): void {
    this.terminalCount += 1;
    if (this.terminalCount === this.nodes.size) {
      this.resolveDone();
    }
  }
}

class NodeInstance {
  status: NodeStatus = "pending";
  output?: JsonValue;
  private determinedEdges = 0;
  private readonly activeInputs: Record<string, JsonValue> = {};

  constructor(
    readonly def: NodeDef,
    private readonly scope: Scope,
  ) {
    scope.ctx.instances.push(this);
  }

  toRecord(): RunRecord {
    const info = this.scope.info;
    const status: InstanceStatus =
      this.status === "pending" || this.status === "running"
        ? "cancelled"
        : this.status;
    return {
      nodeId: this.def.id,
      ...(info.loopId !== undefined ? { loopId: info.loopId } : {}),
      ...(info.iteration !== undefined ? { iteration: info.iteration } : {}),
      status,
      ...(this.status === "success"
        ? { output: this.output as JsonValue }
        : {}),
    };
  }

  startRoot(input: JsonValue): void {
    this.execute(input);
  }

  onEdge(edge: EdgeDef, state: EdgeState, value?: JsonValue): void {
    if (this.status !== "pending") return;
    this.determinedEdges += 1;
    if (state === "active") {
      this.activeInputs[edge.from] = value as JsonValue;
    }
    if (this.determinedEdges < this.scope.incomingCount(this.def.id)) return;
    const activeValues = Object.values(this.activeInputs);
    if (activeValues.length === 0) {
      this.skip();
    } else if (this.def.type === "loop") {
      // A loop node has exactly one incoming edge; its input is the
      // upstream output itself (guaranteed to be an array).
      this.execute(activeValues[0] as JsonValue);
    } else {
      this.execute(this.activeInputs);
    }
  }

  private skip(): void {
    this.status = "skipped";
    this.scope.onNodeTerminal();
    for (const edge of this.scope.outgoingEdges(this.def.id)) {
      this.scope.deliver(edge, "inactive");
    }
  }

  private execute(input: JsonValue): void {
    if (this.scope.ctx.settled !== null) return;
    this.status = "running";
    if (this.def.type === "loop") {
      this.runLoop(input).catch(() => this.scope.ctx.finish("failed"));
      return;
    }
    const handler = this.scope.ctx.handlers[this.def.handler];
    if (handler === undefined) {
      this.scope.ctx.finish("failed");
      return;
    }
    Promise.resolve()
      .then(() => handler(input))
      .then(
        (value) => {
          if (this.scope.ctx.settled !== null) return;
          this.onHandlerSuccess(value);
        },
        () => {
          if (this.scope.ctx.settled !== null) return;
          this.scope.ctx.finish("failed");
        },
      );
  }

  private onHandlerSuccess(value: JsonValue): void {
    this.status = "success";
    this.output = value;
    this.scope.onNodeTerminal();
    if (this.def.type === "decision") {
      const picked = value === true;
      for (const edge of this.scope.outgoingEdges(this.def.id)) {
        const active = edge.when === picked;
        this.scope.deliver(edge, active ? "active" : "inactive", value);
      }
    } else {
      for (const edge of this.scope.outgoingEdges(this.def.id)) {
        this.scope.deliver(edge, "active", value);
      }
    }
  }

  private async runLoop(input: JsonValue): Promise<void> {
    const elements = input as JsonValue[];
    const results: JsonValue[] = new Array<JsonValue>(elements.length);
    const jobs = elements.map((element, index) =>
      this.runIteration(element, index).then((iterationResult) => {
        results[index] = iterationResult;
      }),
    );
    await Promise.all(jobs);
    if (this.scope.ctx.settled !== null) return;
    this.status = "success";
    this.output = results;
    this.scope.onNodeTerminal();
    for (const edge of this.scope.outgoingEdges(this.def.id)) {
      this.scope.deliver(edge, "active", results);
    }
  }

  private async runIteration(
    element: JsonValue,
    index: number,
  ): Promise<JsonValue> {
    const body = (this.def as LoopNodeDef).body;
    const iterScope = new Scope(body, this.scope.ctx, {
      loopId: this.def.id,
      iteration: index,
    });
    await iterScope.run(element);
    const result: Record<string, JsonValue> = {};
    for (const instance of iterScope.nodeInstances()) {
      if (instance.status === "success") {
        result[instance.def.id] = instance.output as JsonValue;
      }
    }
    return result;
  }
}

export async function runWorkflow(
  def: WorkflowDef,
  handlers: HandlerRegistry,
  input: JsonValue,
  timeoutMs: number,
): Promise<RunResult> {
  const ctx = new RunContext(handlers, timeoutMs);
  const outer = new Scope(def, ctx, {});
  ctx.outerScope = outer;
  await Promise.race([outer.run(input), ctx.waitSettled()]);
  if (ctx.settled === null) ctx.finish("success");
  return ctx.buildResult();
}
