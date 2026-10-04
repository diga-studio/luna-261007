import type {
  EdgeDef,
  GraphDef,
  Handler,
  JsonObject,
  JsonValue,
  LoopNodeDef,
  LoopScope,
  NodeDef,
  NodeRecord,
  NodeStatus,
  RunOptions,
  RunResult,
  RunStatus,
} from './types.js';

type NodeState = 'pending' | 'running' | NodeStatus;

interface AbortInfo {
  kind: 'failed' | 'timeout';
}

interface RunContext {
  handlers: Record<string, Handler>;
  records: NodeRecord[];
  abort: AbortInfo | null;
  graphs: Set<GraphExecution>;
}

function isTerminal(state: NodeState): boolean {
  return state !== 'pending' && state !== 'running';
}

class GraphExecution {
  private readonly nodeById = new Map<string, NodeDef>();
  private readonly states = new Map<string, NodeState>();
  private readonly inEdges = new Map<string, EdgeDef[]>();
  private readonly outEdges = new Map<string, EdgeDef[]>();
  private readonly undecided = new Map<string, number>();
  private readonly activeInputs = new Map<string, JsonObject>();
  private readonly outputs: JsonObject = {};
  private pendingCount: number;
  private doneResolve!: () => void;
  readonly done: Promise<void>;

  constructor(
    graph: GraphDef,
    private readonly rootInput: JsonValue,
    private readonly scope: LoopScope[],
    private readonly ctx: RunContext,
  ) {
    for (const node of graph.nodes) {
      this.nodeById.set(node.id, node);
      this.states.set(node.id, 'pending');
      this.inEdges.set(node.id, []);
      this.outEdges.set(node.id, []);
      this.activeInputs.set(node.id, {});
    }
    for (const edge of graph.edges) {
      this.inEdges.get(edge.to)!.push(edge);
      this.outEdges.get(edge.from)!.push(edge);
    }
    for (const node of graph.nodes) {
      this.undecided.set(node.id, this.inEdges.get(node.id)!.length);
    }
    this.pendingCount = graph.nodes.length;
    this.done = new Promise((resolve) => {
      this.doneResolve = resolve;
    });
  }

  start(): void {
    this.ctx.graphs.add(this);
    if (this.ctx.abort) {
      this.sweep();
      return;
    }
    for (const node of this.nodeById.values()) {
      if (this.undecided.get(node.id) === 0) {
        this.executeNode(node, this.rootInput);
      }
    }
    this.checkDone();
  }

  collectOutputs(): JsonObject {
    return this.outputs;
  }

  /** Mark every unfinished instance cancelled and resolve. */
  sweep(): void {
    for (const [id, state] of this.states) {
      if (!isTerminal(state)) {
        this.states.set(id, 'cancelled');
        this.pushRecord(this.nodeById.get(id)!, 'cancelled');
      }
    }
    this.pendingCount = 0;
    this.finish();
  }

  private pushRecord(node: NodeDef, status: NodeStatus, output?: JsonValue): void {
    const record: NodeRecord = { nodeId: node.id, scope: [...this.scope], status };
    if (status === 'success' && output !== undefined) {
      record.output = output;
    }
    this.ctx.records.push(record);
  }

  private finishNode(node: NodeDef, status: NodeStatus, output?: JsonValue): void {
    this.states.set(node.id, status);
    this.pushRecord(node, status, output);
    if (status === 'success') {
      this.outputs[node.id] = output!;
    }
    this.pendingCount -= 1;
    this.checkDone();
  }

  private checkDone(): void {
    if (this.pendingCount === 0) {
      this.finish();
    }
  }

  private finish(): void {
    if (this.ctx.graphs.delete(this)) {
      this.doneResolve();
    }
  }

  private executeNode(node: NodeDef, input: JsonValue): void {
    if (this.ctx.abort) {
      return; // the abort sweep will mark it cancelled
    }
    this.states.set(node.id, 'running');
    if (node.type === 'loop') {
      this.runLoop(node, input);
      return;
    }
    const handler = this.ctx.handlers[node.id]!;
    Promise.resolve()
      .then(() => handler(input))
      .then(
        (value) => this.onHandlerSuccess(node, value),
        () => this.onHandlerFailure(node),
      );
  }

  private onHandlerSuccess(node: NodeDef, value: JsonValue): void {
    if (this.ctx.abort || this.states.get(node.id) !== 'running') {
      return; // late completion after abort: ignore
    }
    this.finishNode(node, 'success', value);
    for (const edge of this.outEdges.get(node.id)!) {
      if (node.type === 'decision') {
        const active = edge.on === value;
        this.deliver(edge, active, active ? value : undefined);
      } else {
        this.deliver(edge, true, value);
      }
    }
  }

  private onHandlerFailure(node: NodeDef): void {
    if (this.ctx.abort || this.states.get(node.id) !== 'running') {
      return; // late failure after abort: ignore
    }
    this.finishNode(node, 'failed');
    this.ctx.abort = { kind: 'failed' };
    for (const graph of [...this.ctx.graphs]) {
      graph.sweep();
    }
  }

  private runLoop(node: LoopNodeDef, input: JsonValue): void {
    const items = input as JsonValue[];
    const iterations = items.map((item, index) => {
      const child = new GraphExecution(
        node.body,
        item,
        [...this.scope, { loopId: node.id, iteration: index }],
        this.ctx,
      );
      child.start();
      return child.done.then(() => child.collectOutputs());
    });
    Promise.all(iterations).then((results) => {
      this.onHandlerSuccess(node, results);
    });
  }

  private deliver(edge: EdgeDef, active: boolean, value?: JsonValue): void {
    if (this.states.get(edge.to) !== 'pending') {
      return;
    }
    if (active) {
      this.activeInputs.get(edge.to)![edge.from] = value!;
    }
    const left = this.undecided.get(edge.to)! - 1;
    this.undecided.set(edge.to, left);
    if (left === 0) {
      this.resolveTarget(edge.to);
    }
  }

  private resolveTarget(targetId: string): void {
    const node = this.nodeById.get(targetId)!;
    const inputs = this.activeInputs.get(targetId)!;
    const sources = Object.keys(inputs);
    if (sources.length === 0) {
      this.finishNode(node, 'skipped');
      for (const edge of this.outEdges.get(targetId)!) {
        this.deliver(edge, false);
      }
      return;
    }
    const input: JsonValue =
      node.type === 'loop' ? inputs[sources[0]!]! : inputs;
    this.executeNode(node, input);
  }
}

export async function runWorkflow(
  graph: GraphDef,
  options: RunOptions,
): Promise<RunResult> {
  const ctx: RunContext = {
    handlers: options.handlers,
    records: [],
    abort: null,
    graphs: new Set(),
  };
  const outer = new GraphExecution(graph, options.input, [], ctx);
  const timer = setTimeout(() => {
    if (ctx.abort) {
      return;
    }
    ctx.abort = { kind: 'timeout' };
    for (const g of [...ctx.graphs]) {
      g.sweep();
    }
  }, options.timeoutMs);
  outer.start();
  await outer.done;
  clearTimeout(timer);
  const status: RunStatus = ctx.abort ? ctx.abort.kind : 'success';
  return { status, output: outer.collectOutputs(), records: ctx.records };
}
