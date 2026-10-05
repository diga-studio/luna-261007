export type QuestionType = "single" | "multiple";

export interface Question {
  id: string;
  type: QuestionType;
  prompt: string;
  options: string[];
  correct: string[];
}

export interface ExamDefinition {
  examId: string;
  title: string;
  durationMs: number;
  passRatio: { numerator: number; denominator: number };
  questions: Question[];
}

export type Answers = Record<string, string[]>;

export type AttemptStatus = "active" | "submitted" | "timeout";

export interface BeginResult {
  attemptId: string;
  deadline: number;
}

export interface SubmitResult {
  attemptId: string;
  status: "submitted" | "timeout";
  passed: boolean;
  correctCount: number;
  totalCount: number;
  certificateId?: string;
}

export interface Certificate {
  certificateId: string;
  attemptId: string;
  learnerId: string;
  examId: string;
  correctCount: number;
  totalCount: number;
  passed: true;
  submittedAt: number;
  issuedAt: number;
}

export interface AttemptRecord {
  attemptId: string;
  learnerId: string;
  examId: string;
  status: AttemptStatus;
  startedAt: number;
  deadline: number;
  submittedAt: number | null;
  answers: Answers | null;
  correctCount: number | null;
  totalCount: number | null;
  passed: boolean | null;
  certificateId: string | null;
}

export interface ResultView {
  attempt: AttemptRecord;
  certificate: Certificate | null;
}

export interface RecoverReport {
  settledTimeouts: string[];
  removedOrphanCertificates: string[];
  repairedCertificates: string[];
}

export interface FaultHooks {
  afterBeginPersist?: () => void;
  afterSubmitPersist?: () => void;
  afterCertificateWrite?: () => void;
}

export interface ExamServiceOptions {
  dataDir: string;
  hooks?: FaultHooks;
}
