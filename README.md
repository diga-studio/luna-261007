# gpa-leaderboard

单学期 GPA 实时排行榜库。课程点数与学分以两位小数字符串传入，内部全部使用
BigInt 有理数运算，排序与并列判断基于未舍入的数学值，展示 GPA 保留两位小数
（half-up）。

## 使用

```ts
import { GpaLeaderboard } from "gpa-leaderboard";

const board = new GpaLeaderboard();
board.upsertGrade("alice", "cs101", "3.75", "4.00"); // 新增或替换该课程成绩
board.removeGrade("alice", "cs101");                 // 移除该课程成绩
board.studentRank("alice");   // => { studentId, gpa, rank } | null
board.leaderboard(0, 10);     // => LeaderboardEntry[]，零起始偏移分页
```

- GPA = Σ(点数 × 学分) / Σ学分。
- 竞赛排名：名次 = 1 + GPA 严格更高的人数；数学值相等（即使总学分不同）即并列。
- 完整榜单按 GPA 降序，同分按 studentId 的 ASCII 字典序升序。
- 删除最后一门成绩后学生立即退出榜单；没有成绩的学生不参与排名。

## 构建与测试

```sh
npm install
npm test
```

只需要 Node.js；`npm test` 会先编译 TypeScript 再运行 `node --test`。
