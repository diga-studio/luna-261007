export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type NodeType = 'work' | 'decision' | 'loop';

export interface BaseNodeDef {
  id: string;
  type: NodeType;
}

export interface WorkNodeDef extends BaseNodeDef {
  type: 'work';
}

export interface DecisionNodeDef extends BaseNodeDef {
  type: 'decision';
}

export interface LoopNodeDef extends BaseNodeDef {
  type: 'loop';
  body: GraphDef;
}

export type NodeDef = WorkNodeDef | DecisionNodeDef | LoopNodeDef;

export interface EdgeDef {
  from: string;
  to: string;
  /** Only meaningful on edges leaving a decision node. */
  on?: boolean;
}

export interface GraphDef {
  nodes: NodeDef[];
  edges: EdgeDef[];
}

/**
 * Root nodes receive the run input (or the loop element for loop-body roots).
 * Other nodes receive a JsonObject of their active inbound sources' outputs,
 * keyed by source node id.
 */
export type WorkHandler = (input: JsonValue) => Promise<JsonValue>;
export type DecisionHandler = (input: JsonValue) => Promise<boolean>;
export type Handler = WorkHandler | DecisionHandler;

export interface RunOptions {
  handlers: Record<string, Handler>;
  input: JsonValue;
  timeoutMs: number;
}

export type NodeStatus = 'success' | 'skipped' | 'failed' | 'cancelled';

/** Identifies one iteration of one loop; nested scopes are ordered outermost-first. */
export interface LoopScope {
  loopId: string;
  iteration: number;
}

export interface NodeRecord {
  nodeId: string;
  /** Empty for outer-graph nodes; one entry per enclosing loop iteration. */
  scope: LoopScope[];
  status: NodeStatus;
  /** Present iff status === 'success'. */
  output?: JsonValue;
}

export type RunStatus = 'success' | 'failed' | 'timeout';

export interface RunResult {
  status: RunStatus;
  /** Outputs of successful outer-graph nodes, keyed by node id. */
  output: JsonObject;
  records: NodeRecord[];
}
