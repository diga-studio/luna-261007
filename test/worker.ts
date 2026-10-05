// 并发测试子进程入口：
//   node dist/test/worker.js <contextFile> <dbPath> <opJson>
// 执行一次操作并把结果 JSON 打印到 stdout。
import { readFileSync } from 'node:fs';
import { ShiftCoverService, StaticContext } from '../src/index';

interface OpPayload {
  op: 'create' | 'accept' | 'decline' | 'cancel';
  key: string;
  openingId?: string;
  employeeId?: string;
  invitationId?: string;
  now: number;
}

function main(): void {
  const [, , contextFile, dbPath, opJson] = process.argv;
  if (!contextFile || !dbPath || !opJson) {
    throw new Error('usage: worker <contextFile> <dbPath> <opJson>');
  }
  const context = JSON.parse(readFileSync(contextFile, 'utf8')) as StaticContext;
  const op = JSON.parse(opJson) as OpPayload;
  const service = new ShiftCoverService({ dbPath, context });
  try {
    let result: unknown;
    if (op.op === 'create') {
      result = service.createInvitation({
        idempotencyKey: op.key,
        openingId: op.openingId as string,
        employeeId: op.employeeId as string,
        now: op.now,
      });
    } else if (op.op === 'accept') {
      result = service.acceptInvitation({
        idempotencyKey: op.key,
        invitationId: op.invitationId as string,
        now: op.now,
      });
    } else if (op.op === 'decline') {
      result = service.declineInvitation({
        idempotencyKey: op.key,
        invitationId: op.invitationId as string,
        now: op.now,
      });
    } else {
      result = service.cancelInvitation({
        idempotencyKey: op.key,
        invitationId: op.invitationId as string,
        now: op.now,
      });
    }
    process.stdout.write(JSON.stringify(result));
  } finally {
    service.close();
  }
}

main();
