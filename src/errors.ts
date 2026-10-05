export class StoreError extends Error {}

export class ValidationError extends StoreError {}

export class UploadNotFoundError extends StoreError {
  constructor(public readonly uploadId: string) {
    super(`upload not found: ${uploadId}`);
  }
}

export class DeclarationMismatchError extends StoreError {
  constructor(public readonly uploadId: string) {
    super(`declaration mismatch for upload: ${uploadId}`);
  }
}

export class ChunkConflictError extends StoreError {
  constructor(
    public readonly uploadId: string,
    public readonly chunkIndex: number,
  ) {
    super(`conflicting content for chunk ${chunkIndex} of upload ${uploadId}`);
  }
}

export class InvalidChunkError extends StoreError {}

export class UploadIncompleteError extends StoreError {
  constructor(public readonly uploadId: string) {
    super(`upload is not complete: ${uploadId}`);
  }
}

export class DigestMismatchError extends StoreError {
  constructor(public readonly uploadId: string) {
    super(`assembled content does not match declaration: ${uploadId}`);
  }
}
