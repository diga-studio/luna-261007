export type VaultErrorCode =
  | "NO_GRANT"
  | "GRANT_EXPIRED"
  | "VIEWS_EXHAUSTED"
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "USER_MISMATCH"
  | "GRANT_SUPERSEDED";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}
