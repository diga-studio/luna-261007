import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock, ContentSource, Grant, SecureVaultOptions } from './types.js';

export type VaultErrorCode =
  | 'GRANT_NOT_FOUND'
  | 'GRANT_EXPIRED'
  | 'VIEWS_EXHAUSTED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'USER_MISMATCH'
  | 'ACCESS_REVOKED';

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}

interface GrantRecord {
  id: number;
  expiresAt: number | null;
  maxViews: number | null;
  viewsUsed: number;
}

interface TokenPayload {
  u: string;
  d: string;
  g: number;
  e: number;
}

const DEFAULT_TOKEN_TTL_MS = 60_000;

function grantKey(userId: string, documentId: string): string {
  return `${userId} ${documentId}`;
}

export class SecureVault {
  private readonly source: ContentSource;
  private readonly clock: Clock;
  private readonly tokenTtlMs: number;
  private readonly secret: Uint8Array;
  private readonly grants = new Map<string, GrantRecord>();
  private nextGrantId = 1;

  constructor(options: SecureVaultOptions) {
    this.source = options.source;
    this.clock = options.clock ?? (() => Date.now());
    this.tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
    this.secret =
      options.secret === undefined
        ? randomBytes(32)
        : typeof options.secret === 'string'
          ? new TextEncoder().encode(options.secret)
          : options.secret;
  }

  setGrant(userId: string, documentId: string, grant: Grant | null): void {
    const key = grantKey(userId, documentId);
    if (grant === null) {
      this.grants.delete(key);
      return;
    }
    this.grants.set(key, {
      id: this.nextGrantId++,
      expiresAt: grant.expiresAt,
      maxViews: grant.maxViews,
      viewsUsed: 0,
    });
  }

  issueToken(userId: string, documentId: string): string {
    const record = this.grants.get(grantKey(userId, documentId));
    if (!record) {
      throw new VaultError('GRANT_NOT_FOUND', `no grant for ${userId}/${documentId}`);
    }
    const now = this.clock();
    if (record.expiresAt !== null && now >= record.expiresAt) {
      throw new VaultError('GRANT_EXPIRED', 'grant has expired');
    }
    if (record.maxViews !== null && record.viewsUsed >= record.maxViews) {
      throw new VaultError('VIEWS_EXHAUSTED', 'no remaining views');
    }
    const payload: TokenPayload = {
      u: userId,
      d: documentId,
      g: record.id,
      e: now + this.tokenTtlMs,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  open(userId: string, token: string): AsyncIterable<Uint8Array> {
    const payload = this.verifyToken(token);
    if (payload.u !== userId) {
      throw new VaultError('USER_MISMATCH', 'token is bound to a different user');
    }
    return this.createStream(payload);
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  private verifyToken(token: string): TokenPayload {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) {
      throw new VaultError('TOKEN_INVALID', 'malformed token');
    }
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new VaultError('TOKEN_INVALID', 'bad token signature');
    }
    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    } catch {
      throw new VaultError('TOKEN_INVALID', 'malformed token payload');
    }
    if (
      typeof payload.u !== 'string' ||
      typeof payload.d !== 'string' ||
      typeof payload.g !== 'number' ||
      typeof payload.e !== 'number'
    ) {
      throw new VaultError('TOKEN_INVALID', 'malformed token payload');
    }
    return payload;
  }

  private createStream(payload: TokenPayload): AsyncIterable<Uint8Array> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const vault = this;
    const key = grantKey(payload.u, payload.d);

    function currentRecord(): GrantRecord {
      const record = vault.grants.get(key);
      if (!record || record.id !== payload.g) {
        throw new VaultError('ACCESS_REVOKED', 'grant was revoked or replaced');
      }
      return record;
    }

    function checkLive(record: GrantRecord): void {
      const now = vault.clock();
      if (record.expiresAt !== null && now >= record.expiresAt) {
        throw new VaultError('GRANT_EXPIRED', 'grant has expired');
      }
      if (now >= payload.e) {
        throw new VaultError('TOKEN_EXPIRED', 'token has expired');
      }
    }

    return {
      [Symbol.asyncIterator]() {
        let iterator: AsyncIterator<Uint8Array> | null = null;
        let counted = false;

        async function ensureIterator(): Promise<AsyncIterator<Uint8Array>> {
          if (iterator === null) {
            const iterable = await vault.source.open(payload.d);
            iterator = iterable[Symbol.asyncIterator]();
          }
          return iterator;
        }

        const streamIterator: AsyncIterator<Uint8Array> = {
          async next(): Promise<IteratorResult<Uint8Array>> {
            for (;;) {
              // 读取前先快速失败，避免权限失效后还继续读底层数据。
              checkLive(currentRecord());
              const it = await ensureIterator();
              const result = await it.next();
              if (result.done === true) {
                // 读取等待期间权限可能已失效：不允许以正常结束掩盖权限中断。
                checkLive(currentRecord());
                return { done: true, value: undefined };
              }
              const chunk = result.value;
              if (chunk.length === 0) {
                continue;
              }
              // 交付点：await 之后、兑现之前同步完成全部校验与扣次，保证原子性。
              const record = currentRecord();
              checkLive(record);
              if (!counted) {
                if (record.maxViews !== null && record.viewsUsed >= record.maxViews) {
                  throw new VaultError('VIEWS_EXHAUSTED', 'no remaining views');
                }
                record.viewsUsed += 1;
                counted = true;
              }
              return { done: false, value: chunk };
            }
          },
          async return(): Promise<IteratorResult<Uint8Array>> {
            if (iterator !== null && iterator.return !== undefined) {
              await iterator.return();
            }
            return { done: true, value: undefined };
          },
        };
        return streamIterator;
      },
    };
  }
}
