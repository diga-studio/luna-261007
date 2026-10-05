/** 库对外抛出的错误类型。 */
export class IngestError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

export class NotFoundError extends IngestError {
  constructor(uploadId: string) {
    super("UPLOAD_NOT_FOUND", `upload not found: ${uploadId}`);
    this.name = "NotFoundError";
  }
}

export class DeclarationConflictError extends IngestError {
  constructor(uploadId: string) {
    super(
      "DECLARATION_CONFLICT",
      `upload ${uploadId} already registered with a different declaration`,
    );
    this.name = "DeclarationConflictError";
  }
}

export class InvalidDeclarationError extends IngestError {
  constructor(message: string) {
    super("INVALID_DECLARATION", message);
    this.name = "InvalidDeclarationError";
  }
}

export class InvalidChunkError extends IngestError {
  constructor(message: string) {
    super("INVALID_CHUNK", message);
    this.name = "InvalidChunkError";
  }
}

export class ChunkConflictError extends IngestError {
  constructor(uploadId: string, seq: number) {
    super(
      "CHUNK_CONFLICT",
      `chunk ${seq} of upload ${uploadId} already exists with different content`,
    );
    this.name = "ChunkConflictError";
  }
}

export class IncompleteUploadError extends IngestError {
  constructor(uploadId: string) {
    super("INCOMPLETE_UPLOAD", `upload ${uploadId} is missing chunks`);
    this.name = "IncompleteUploadError";
  }
}

export class DigestMismatchError extends IngestError {
  constructor(uploadId: string) {
    super(
      "DIGEST_MISMATCH",
      `assembled content of upload ${uploadId} does not match the declared length or sha256`,
    );
    this.name = "DigestMismatchError";
  }
}
