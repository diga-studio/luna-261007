/** 验真失败原因码。 */
export type RejectCode =
  | "IO_ERROR"
  | "NOT_ZIP"
  | "ZIP_UNSUPPORTED_FEATURE"
  | "ZIP_STRUCTURE_INVALID"
  | "ZIP_ENTRY_MISMATCH"
  | "ZIP_ENTRY_CRC_MISMATCH"
  | "ZIP_ENTRY_SIZE_MISMATCH"
  | "ZIP_ENTRY_OVERLAP"
  | "ZIP_NAME_INVALID"
  | "ZIP_PATH_INVALID"
  | "ZIP_DUPLICATE_PATH"
  | "OOXML_PART_MISSING"
  | "OOXML_XML_INVALID"
  | "OOXML_CONTENT_TYPE_INVALID"
  | "OOXML_ROOT_REL_INVALID"
  | "OOXML_MAIN_PART_INVALID";

export interface ValidationFailure {
  ok: false;
  code: RejectCode;
  message: string;
}

export interface ValidationSuccess {
  ok: true;
  /** 主部件（正文）在包内的路径，例如 "word/document.xml"。 */
  mainPart: string;
  /** 包内条目数。 */
  entryCount: number;
}

export type ValidationResult = ValidationSuccess | ValidationFailure;

export function fail(code: RejectCode, message: string): ValidationFailure {
  return { ok: false, code, message };
}
