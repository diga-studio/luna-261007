/** 学习者对单道题的作答。 */
export interface Answer {
  questionId: string;
  /** 选中的选项 id 列表；单选恰好 1 个，多选 1 个或多个。 */
  selected: string[];
}

export type QuestionKind = 'single' | 'multi';

export interface ExamQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  options: { id: string; text: string }[];
  /** 正确选项 id 集合（有序存储，判分时按集合比较）。 */
  correct: string[];
}

export interface BeginResult {
  attemptId: string;
  deadline: number;
}

export type AttemptStatus = 'active' | 'submitted' | 'timeout';

export interface SubmitResult {
  attemptId: string;
  passed: boolean;
  /** 超时失败时为 true。 */
  timedOut: boolean;
  correctCount: number;
  totalCount: number;
  certificateId?: string;
}

export interface Certificate {
  certificateId: string;
  attemptId: string;
  learnerId: string;
  correctCount: number;
  totalCount: number;
  issuedAt: number;
}

export interface AttemptResult {
  attemptId: string;
  learnerId: string;
  status: AttemptStatus;
  startedAt: number;
  deadline: number;
  submission?: {
    submittedAt: number;
    valid: boolean;
    correctCount: number;
    totalCount: number;
    passed: boolean;
    certificateId?: string;
  };
  certificate?: Certificate;
}

export class ExamError extends Error {
  constructor(
    public readonly code:
      | 'ATTEMPT_IN_PROGRESS'
      | 'MAX_ATTEMPTS_REACHED'
      | 'COOLDOWN_ACTIVE'
      | 'ATTEMPT_NOT_FOUND'
      | 'ATTEMPT_ALREADY_SETTLED',
    message: string,
  ) {
    super(message);
    this.name = 'ExamError';
  }
}
