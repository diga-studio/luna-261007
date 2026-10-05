export type RejectCode =
  | "NOT_ZIP"
  | "ZIP_UNSUPPORTED_FEATURE"
  | "ZIP_STRUCTURE_INVALID"
  | "ZIP_ENTRY_CORRUPT"
  | "ZIP_PATH_INVALID"
  | "OPC_PART_MISSING"
  | "OPC_RELATIONSHIP_INVALID"
  | "OPC_CONTENT_TYPE_INVALID"
  | "XML_INVALID"
  | "NOT_DOCX"
  | "IO_ERROR";

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: RejectCode; message: string };

export function reject(code: RejectCode, message: string): ValidationResult {
  return { ok: false, code, message };
}

export const OK: ValidationResult = { ok: true };
