export { LogicalClock } from './clock.ts';
export {
  MarketingAutomation,
  ATTEMPT_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  MAX_ATTEMPTS,
} from './engine.ts';
export type { AdvanceResult } from './engine.ts';
export type {
  AttemptOutcome,
  AttemptRecord,
  ChainEndReason,
  ChainStatus,
  ChainView,
  MarketingEvent,
  SendOutcome,
  SendRequest,
  Simulator,
  StepPlan,
  StepStatus,
  StepView,
} from './types.ts';
