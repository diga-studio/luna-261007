import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  fsyncSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Certificate } from './types.js';

const CERT_SUFFIX = '.json';
const TMP_SUFFIX = '.json.tmp';

function serialize(cert: Certificate): string {
  return (
    JSON.stringify(
      {
        certificateId: cert.certificateId,
        attemptId: cert.attemptId,
        learnerId: cert.learnerId,
        correctCount: cert.correctCount,
        totalCount: cert.totalCount,
        issuedAt: cert.issuedAt,
      },
      null,
      2,
    ) + '\n'
  );
}

function sameCertificate(a: Certificate, b: Certificate): boolean {
  return (
    a.certificateId === b.certificateId &&
    a.attemptId === b.attemptId &&
    a.learnerId === b.learnerId &&
    a.correctCount === b.correctCount &&
    a.totalCount === b.totalCount &&
    a.issuedAt === b.issuedAt
  );
}

/**
 * 本地 JSON 证书文件管理。
 * 写入采用“临时文件 + fsync + 原子重命名”，重命名成功即视为证书完整落盘；
 * 崩溃遗留的临时文件与不完整文件由 reconcile 清除。
 */
export class CertificateStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'certificates');
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(certificateId: string): string {
    return join(this.dir, `${certificateId}${CERT_SUFFIX}`);
  }

  /** 原子写入证书；返回时证书已完整落盘。 */
  write(cert: Certificate): void {
    const tmpPath = join(this.dir, `${cert.certificateId}${TMP_SUFFIX}`);
    writeFileSync(tmpPath, serialize(cert), 'utf8');
    const fd = openSync(tmpPath, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this.pathFor(cert.certificateId));
    this.fsyncDir();
  }

  read(certificateId: string): Certificate | undefined {
    const path = this.pathFor(certificateId);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Certificate;
      if (typeof parsed.certificateId !== 'string' || parsed.certificateId !== certificateId) {
        return undefined;
      }
      return parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * 以账本为准对账：删除无主、不完整或与账本不符的证书文件及临时文件，
   * 补写账本中存在但磁盘缺失的证书。完成后磁盘与账本严格一致。
   */
  reconcile(expected: Certificate[]): void {
    const expectedById = new Map(expected.map((cert) => [cert.certificateId, cert]));
    for (const entry of readdirSync(this.dir)) {
      const fullPath = join(this.dir, entry);
      if (!entry.endsWith(CERT_SUFFIX)) {
        rmSync(fullPath, { force: true });
        continue;
      }
      const certificateId = entry.slice(0, -CERT_SUFFIX.length);
      const expectedCert = expectedById.get(certificateId);
      const onDisk = expectedCert ? this.read(certificateId) : undefined;
      if (!expectedCert || !onDisk || !sameCertificate(onDisk, expectedCert)) {
        rmSync(fullPath, { force: true });
      }
    }
    for (const cert of expected) {
      if (!existsSync(this.pathFor(cert.certificateId))) {
        this.write(cert);
      }
    }
    this.fsyncDir();
  }

  private fsyncDir(): void {
    const fd = openSync(this.dir, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
}
