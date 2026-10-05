/** 实例终态与进行态 */
export type InstanceStatus = 'active' | 'approved' | 'rejected' | 'withdrawn';

/** 层状态：pending=未来层, active=当前可办理层, completed=已完成层 */
export type LayerStatus = 'pending' | 'active' | 'completed';

/** 待办状态：open=可办理, done=已办理, invalid=已失效 */
export type TodoStatus = 'open' | 'done' | 'invalid';

export interface SubmitInput {
  /** 发起人（身份由上层核实） */
  initiator: string;
  /** 变更字段数：<=50 只走普通层，>50 先普通层再高级层 */
  fieldCount: number;
  /** 普通层审批人名单 */
  normalApprovers: string[];
  /** 高级层审批人名单（fieldCount>50 时必填） */
  seniorApprovers?: string[];
}

export type ApprovalAction = 'approve' | 'reject';

export interface ActInput {
  /** 待办 ID（同意/驳回必须针对操作者当前有效待办） */
  todoId: string;
  operator: string;
  action: ApprovalAction;
}

export interface LayerView {
  seq: number;
  kind: 'normal' | 'senior';
  status: LayerStatus;
  approvers: { person: string; approved: boolean }[];
}

export interface InstanceView {
  id: string;
  initiator: string;
  fieldCount: number;
  status: InstanceStatus;
  layers: LayerView[];
}

export interface TodoView {
  id: string;
  instanceId: string;
  layerSeq: number;
  kind: 'normal' | 'senior';
  assignee: string;
  status: TodoStatus;
}
