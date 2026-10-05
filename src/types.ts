/** 实例状态：审批中 / 已通过 / 已驳回 / 已撤回 */
export type InstanceStatus = "pending" | "approved" | "rejected" | "withdrawn";

/** 审批层类型：普通层 / 高级层 */
export type LayerType = "normal" | "senior";

/** 待办状态：有效 / 已办理 / 已失效 */
export type TodoStatus = "active" | "done" | "invalid";

/** 提交实例的入参 */
export interface SubmitInput {
  /** 发起人（身份由上层业务核实） */
  initiator: string;
  /** 变更字段数：不超过 50 只走普通层，超过 50 先普通层再高级层 */
  fieldCount: number;
  /** 普通层审批人名单 */
  normalApprovers: string[];
  /** 高级层审批人名单（fieldCount > 50 时必填） */
  seniorApprovers?: string[];
}

/** 审批层视图 */
export interface LayerView {
  index: number;
  type: LayerType;
  /** 当前在该层的审批人 */
  approvers: string[];
  /** 当前仍有效的同意 */
  consented: string[];
  /** 该层是否已完成（全员同意） */
  completed: boolean;
}

/** 实例视图 */
export interface InstanceView {
  id: string;
  initiator: string;
  fieldCount: number;
  status: InstanceStatus;
  /** 当前最早未完成层的下标；终态时为 null */
  currentLayerIndex: number | null;
  layers: LayerView[];
}

/** 待办视图 */
export interface TodoView {
  id: string;
  instanceId: string;
  layerIndex: number;
  assignee: string;
}
