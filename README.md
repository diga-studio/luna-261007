# enrollment-backfill

选课与候补回填库（TypeScript + SQLite），由上层教务系统调用。
只处理一个固定报名轮次：选课、退课，以及按学生或班级查询当前已选与候补状态。

## 环境要求

- Node.js >= 22.5（使用内置 `node:sqlite`，无任何原生/外部服务依赖）
- `npm install` 后 `npm test` 即可运行全部测试（编译 + node:test）

```bash
npm install
npm test
```

## API

```ts
import { EnrollmentService } from "enrollment-backfill";

const svc = new EnrollmentService("round.db", [
  { classId: "A", capacity: 30, startMin: 480, endMin: 540 }, // 时段含起点、不含终点
]);

svc.enroll("s1", "A");          // { status: "enrolled" | "waitlisted", seq }
svc.drop("s1", "A");            // 撤销有效申请（已选或候补），无申请则不变
svc.getStudentStatus("s1");     // { enrolled, waitlisted }
svc.getClassStatus("A");        // { capacity, enrolledCount, enrolled, waitlisted }
svc.bulkLoad([...]);            // 轮次初始化时批量载入既有申请
svc.stats();                    // 全轮次已选/候补计数
```

## 设计要点

- **存储**：SQLite（`node:sqlite` 同步驱动）。`applications.seq` 为
  `INTEGER PRIMARY KEY AUTOINCREMENT`，即本轮唯一递增受理序号；
  `(student_id, class_id)` 唯一索引保证每学生每班最多一条有效申请。
- **并发模型**：同步驱动 + 每个写操作（撤销 + 全部回填）包在单个
  `IMMEDIATE` 事务中，请求在事件循环上天然串行，查询不可能看到事务中间状态，
  等价于按实际完成顺序的串行执行。
- **回填**：维护不变量"不存在班级有空位且学生无时间冲突的候补"。
  每次写操作前不变量成立，而一次选/退只能影响"该班候补"与"该生候补"的资格，
  因此写操作做定向回填（UNION 两条索引查询）即可恢复全局不变量；
  批量载入后做一次全量回填建立不变量。被跳过的候补保留原序号。
- **时间冲突**：时段为 `[startMin, endMin)`，首尾相接不算冲突。

## 测试

- `test/basic.test.ts`：容量、候补、序号递增、重复申请、退课语义、
  首尾相接、冲突不录取等单元规则。
- `test/replay.test.ts`：随机连续选退课，每一步与纯内存参考模型
  （严格按规格全局推演）的全量状态逐步一致。
- `test/conflict.test.ts`：退课后同时具备两个冲突班级的回填资格，
  只进序号较早者，另一条候补保留；被跳过候补保留原序号。
- `test/concurrency.test.ts`：满班退课与新申请并发，新申请不越过
  可晋级旧候补；并发期间任何查询都看不到回填中间状态；最终结果
  等价于按完成顺序的串行重放。
- `test/perf.test.ts`：2 万班级 / 10 万学生 / 120 万申请
  （回填后 60 万候补）规模下，100 个并发选退课请求与 1000 次学生查询计时。
  本机实测：100 请求约 14ms（要求 < 2s），学生查询 p95 约 0.03ms（要求 < 100ms）。
