export interface UploadDeclaration {
  uploadId: string;
  totalSize: number;
  sha256: string;
}

export type UploadState = 'uploading' | 'completed';

export interface UploadStatus {
  uploadId: string;
  state: UploadState;
  totalSize: number;
  sha256: string;
  chunkCount: number;
  receivedChunks: number[];
  artifactPath: string | null;
}

export interface FinalizeResult {
  uploadId: string;
  artifactPath: string;
}
