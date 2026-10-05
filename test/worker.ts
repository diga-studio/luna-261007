// 并发测试子进程：对同一数据文件执行一次邀约，把结果以 JSON 打到 stdout。
import { InviteService } from '../src/index.ts';

const [dbPath, key, gapId, employeeId, nowMin] = process.argv.slice(2);
const service = new InviteService(dbPath!);
const result = service.invite({
  key: key!,
  gapId: gapId!,
  employeeId: employeeId!,
  nowMin: Number(nowMin),
});
service.close();
process.stdout.write(JSON.stringify(result));
