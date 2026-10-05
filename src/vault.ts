import { randomBytes } from "node:crypto";
import { VaultError } from "./errors.js";
import { TokenSigner } from "./token.js";
import type { TokenPayload } from "./token.js";
import { MAX_CHUNK_BYTES, TOKEN_TTL_MS } from "./types.js";
import type { Clock, ContentSource, Grant } from "./types.js";

export interface SecureVaultOptions {
  source: ContentSource;
  clock?: Clock;
  secret?: Uint8Array;
}

interface GrantRecord {
  id: number;
  expiresAt: number | null;
  maxViews: number | null;
  used: number;
}

function keyOf(userId: string, documentId: string): string {
  return JSON.stringify([userId, documentId]);
}

export class SecureVault {
  readonly #source: ContentSource;
  readonly #clock: Clock;
  readonly #signer: TokenSigner;
  readonly #grants = new Map<string, GrantRecord>();
  #nextGrantId = 1;

  constructor(options: SecureVaultOptions) {
    this.#source = options.source;
    this.#clock = options.clock ?? Date.now;
    this.#signer = new TokenSigner(options.secret ?? randomBytes(32));
  }

  setGrant(userId: string, documentId: string, grant: Grant | null): void {
    const key = keyOf(userId, documentId);
    if (grant === null) {
      this.#grants.delete(key);
      return;
    }
    this.#grants.set(key, {
      id: this.#nextGrantId++,
      expiresAt: grant.expiresAt,
      maxViews: grant.maxViews,
      used: 0,
    });
  }

  issueToken(userId: string, documentId: string): string {
    const rec = this.#grants.get(keyOf(userId, documentId));
    if (!rec) throw new VaultError("NO_GRANT", "no grant for user/document");
    const now = this.#clock();
    if (rec.expiresAt !== null && now >= rec.expiresAt) {
      throw new VaultError("GRANT_EXPIRED", "grant has expired");
    }
    if (rec.maxViews !== null && rec.used >= rec.maxViews) {
      throw new VaultError("VIEWS_EXHAUSTED", "no remaining views");
    }
    return this.#signer.sign({
      userId,
      documentId,
      grantId: rec.id,
      expiresAt: now + TOKEN_TTL_MS,
    });
  }

  open(userId: string, token: string): AsyncIterable<Uint8Array> {
    const payload = this.#signer.verify(token);
    if (payload.userId !== userId) {
      throw new VaultError("USER_MISMATCH", "token bound to a different user");
    }
    return this.#makeStream(payload);
  }

  /**
   * 交付前的同步原子检查：授权仍然当前、两个期限未过、（首块时）剩余次数充足。
   * 检查与扣次之间没有任何 await，因此对并发流是原子的。
   */
  #authorizeDelivery(payload: TokenPayload, consumed: boolean): boolean {
    const rec = this.#grants.get(keyOf(payload.userId, payload.documentId));
    if (!rec || rec.id !== payload.grantId) {
      throw new VaultError("GRANT_SUPERSEDED", "grant revoked or replaced");
    }
    const now = this.#clock();
    if (rec.expiresAt !== null && now >= rec.expiresAt) {
      throw new VaultError("GRANT_EXPIRED", "grant has expired");
    }
    if (now >= payload.expiresAt) {
      throw new VaultError("TOKEN_EXPIRED", "token has expired");
    }
    if (!consumed) {
      if (rec.maxViews !== null && rec.used >= rec.maxViews) {
        throw new VaultError("VIEWS_EXHAUSTED", "no remaining views");
      }
      rec.used += 1;
      return true;
    }
    return consumed;
  }

  /**
   * 包装生成器：一旦某个 next() 因权限失效而拒绝，
   * 后续 next() 都以同一错误拒绝，绝不以正常结束掩盖权限中断。
   */
  #makeStream(payload: TokenPayload): AsyncIterable<Uint8Array> {
    const generator = this.#generate(payload);
    let terminal: { error: unknown } | null = null;
    const iterator: AsyncIterator<Uint8Array> = {
      async next(): Promise<IteratorResult<Uint8Array>> {
        if (terminal) throw terminal.error;
        try {
          return await generator.next();
        } catch (error) {
          terminal = { error };
          throw error;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<Uint8Array>> {
        if (terminal) throw terminal.error;
        return (await generator.return(value)) as IteratorResult<Uint8Array>;
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  async *#generate(payload: TokenPayload): AsyncGenerator<Uint8Array> {
    const iterator = this.#source.open(payload.documentId)[Symbol.asyncIterator]();
    let consumed = false;
    try {
      for (;;) {
        const { value, done } = await iterator.next();
        if (done) return;
        if (!(value instanceof Uint8Array)) {
          throw new Error("content source yielded a non-Uint8Array chunk");
        }
        if (value.byteLength > MAX_CHUNK_BYTES) {
          throw new Error("content source chunk exceeds 64 KiB");
        }
        if (value.byteLength === 0) continue;
        consumed = this.#authorizeDelivery(payload, consumed);
        yield value;
      }
    } finally {
      await iterator.return?.();
    }
  }
}
