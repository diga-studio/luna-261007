export type FileStatus =
  | "pending"
  | "cleaned"
  | "restored"
  | "conflict"
  | "purged";

export interface JobFileResult {
  path: string;
  status: FileStatus;
}

export interface JobView {
  jobId: string;
  receivedAt: number;
  expiresAt: number;
  files: JobFileResult[];
}

export interface OperationReport {
  jobId: string;
  files: JobFileResult[];
}
