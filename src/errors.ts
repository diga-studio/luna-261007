export type ApprovalErrorCode =
  | "INSTANCE_NOT_FOUND"
  | "INSTANCE_NOT_PENDING"
  | "TODO_NOT_FOUND"
  | "TODO_NOT_ACTIVE"
  | "TODO_NOT_ASSIGNEE"
  | "LAYER_OUT_OF_RANGE"
  | "LAYER_NOT_STARTED"
  | "APPROVER_NOT_IN_LAYER"
  | "APPROVER_ALREADY_IN_LAYER"
  | "NOT_INITIATOR"
  | "INVALID_INPUT";

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;
  constructor(code: ApprovalErrorCode, message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = code;
  }
}
