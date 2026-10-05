import type { RetainageBatchInput, RetainageBatchResult } from "./types";
import { solveRetainageBatch } from "./solve";

export type {
  RetainageBatchInput,
  RetainageBatchResult,
  RetainagePeriodResult,
  ItemRetainage,
} from "./types";

/**
 * 对一批尚未确认的连续付款申请做整批扣留款分摊。
 * 输入与结果仅保存在进程内，由上层财务程序调用。
 */
export function allocateRetainageBatch(
  input: RetainageBatchInput,
): RetainageBatchResult {
  return solveRetainageBatch(input);
}
