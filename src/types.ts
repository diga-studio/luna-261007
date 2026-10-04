export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type NodeType = "task" | "decision" | "loop";

export interface TaskNodeDef {
  id: string;
  type: "task";
  handler: string;
}

export interface DecisionNodeDef {
  id: string;
  type: "decision";
  handler: string;
}

export interface LoopNodeDef {
  id: string;
  type: "loop";
  body: WorkflowDef;
}

export type NodeDef = TaskNodeDef | DecisionNodeDef | LoopNodeDef;

export interface EdgeDef {
  from: string;
  to: string;
  /** Only meaningful on outgoing edges of decision nodes. */
  when?: boolean;
}

export interface WorkflowDef {
  nodes: NodeDef[];
  edges: EdgeDef[];
}

export type Handler = (input: JsonValue) => Promise<JsonValue>;

export type HandlerRegistry = Record<string, Handler>;

export type InstanceStatus = "success" | "skipped" | "cancelled";

export interface RunRecord {
  nodeId: string;
  loopId?: string;
  iteration?: number;
  status: InstanceStatus;
  output?: JsonValue;
}

export type RunStatus = "success" | "failed" | "timeout";

export interface RunResult {
  status: RunStatus;
  /** Outputs of successful outer-graph nodes, keyed by node id. */
  output: Record<string, JsonValue>;
  records: RunRecord[];
}

export interface RunOptions {
  handlers: HandlerRegistry;
  input: JsonValue;
  /** Wall-clock budget for the whole run, including queueing and all loop iterations. */
  timeoutMs: number;
}
