# enrollment-backfill

选课与候补回填库（TypeScript + SQLite），由上层教务系统调用。
只提供选课、退课，以及按学生或班级查询当前已选与候补状态；
只处理一个固定报名轮次。

## 运行要求

- Node.js ≥ 23.4（使用内置 `node:sqlite`，无任何原生依赖）
- `npm install` 后 `npm test` 即可构建并运行全部测试

```bash
npm install
npm test        # tsc 构建 + node --test
npm run build   # 仅构建到 dist/
```

## API

```ts
import { EnrollmentSystem } from "enrollment-backfill";

// 新建库：本轮固定的班级容量与时段由上层提供（容量 1..30，
// 时段为同一时间轴上的整数分钟，含起点、不含终点）
const sys = EnrollmentSystem.create("round1.db", [
  { classId: "CS101-A", capacity: 30, startMin: 480, endMin: 540 },
]);

// 或打开已有库（进程重启后恢复）
const sys2 = EnrollmentSystem.open("round1.db");

sys.enroll("stu-1", "CS101-A"); // -> { status, seq }；已有有效申请时幂等
sys.drop("stu-1", "CS101-A");   // 撤销已选或候补；无有效申请则不改变状态
sys.getStudentState("stu-1");   // -> { enrolled, waitlisted }（按受理序号升序）
sys.getClassState("CS101-A");   // -> { capacity, enrolled, waitlisted }
sys.close();
```

所有方法均为**同步**方法。

## 语义规则

- 一名学生在同一班级最多一条有效申请（已选或候补）；退课撤销之，
  重新申请取得新的全轮次递增受理序号。
- 新申请先进入候补，随后立即参与回填。
- 回填：在全轮次所有尚有空位的班级中，反复晋级受理序号最小且
  当前具备资格的候补（晋级后不与该生任何已选班级时间冲突），
  直到不存在可晋级的候补。因冲突被跳过的候补保留原序号。
- 任何选/退课引起的状态变化都会触发完整回填，无需学生再次申请。

## 设计要点

- **串行化**：所有公开方法同步执行，一次选/退课连同其触发的全部
  回填在同一个同步执行片段与同一个 SQLite 事务中完成。Node 事件
  循环不会在中途插入其他请求，因此并发调用天然等价于按实际完成
  先后排列的串行执行，查询不可能看到中间状态。
- **增量回填**：晋级只会消耗空位、增加冲突，不会使任何其他候补新
  获得资格。因此每次只需把"资格可能改观的候补"（空出座位班级的
  候补 + 退课学生本人的候补）作为候选集合，按序号贪心晋级即可，
  无需全量扫描 50 万条候补。
- **持久化**：内存状态为查询加速的物化视图，每次业务变化在同一
  事务内写透 SQLite（WAL）；落盘失败时以数据库为准重建内存。
  受理序号由 `INTEGER PRIMARY KEY AUTOINCREMENT` 分配，重开后继续递增。

## 测试

- `test/basic.test.ts`：基本规则（幂等、序号、容量、冲突、边界相接）。
- `test/backfill.test.ts`：退课后同时具备两个冲突班级的回填资格，
  只进序号较早者、另一条候补保留；全局按序号回填的联动。
- `test/replay.test.ts`：多组随机种子的连续选退课，每一步都与
  独立的参考实现（从头按受理序号全量推演）全量比对。
- `test/concurrency.test.ts`：满班退课与新申请并发（新申请不越过
  可晋级旧候补）；100 个并发请求期间每个宏任务校验不变量
  （不超容量、无时间冲突、无空位与可晋级候补并存），终态与按实际
  完成顺序的串行重放一致，重开库后状态一致。
- `test/perf.test.ts`：2 万班级 / 10 万学生 / 50 万候补预载数据上，
  100 个并发选退课（每次资格变化 ≤20 条）与 2000 次学生查询的耗时
  验证（断言：总耗时 < 2s，查询 p95 < 100ms）。
