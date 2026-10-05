import { createHmac, timingSafeEqual } from "node:crypto";
import { VaultError } from "./errors.js";

/** 签名令牌的签发与验证（HMAC-SHA256）。 */
export interface TokenPayload {
  userId: string;
  documentId: string;
  grantId: number;
  expiresAt: number;
}

export class TokenSigner {
  readonly #secret: Uint8Array;

  constructor(secret: Uint8Array) {
    this.#secret = secret;
  }

  sign(payload: TokenPayload): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const mac = createHmac("sha256", this.#secret).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  verify(token: string): TokenPayload {
    const dot = token.lastIndexOf(".");
    if (dot <= 0) throw new VaultError("INVALID_TOKEN", "malformed token");
    const body = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    const expected = createHmac("sha256", this.#secret).update(body).digest();
    const actual = Buffer.from(mac, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new VaultError("INVALID_TOKEN", "bad token signature");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new VaultError("INVALID_TOKEN", "undecodable token payload");
    }
    const p = payload as Record<string, unknown>;
    if (
      typeof p["userId"] !== "string" ||
      typeof p["documentId"] !== "string" ||
      typeof p["grantId"] !== "number" ||
      typeof p["expiresAt"] !== "number"
    ) {
      throw new VaultError("INVALID_TOKEN", "token payload shape mismatch");
    }
    return payload as TokenPayload;
  }
}
