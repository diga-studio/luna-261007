# gpa-leaderboard

单学期 GPA 实时排行榜库（TypeScript）。课程 GPA 点数由调用方按评分规则算好，
本库只接收点数与学分，全部状态驻留内存，调用串行执行。

## 构建与测试

只装了 Node.js 的干净机器上：

```sh
npm install
npm test
```

`npm test` 先用 `tsc` 编译到 `dist/`，再用 Node 内置测试运行器执行全部测试。
唯一的开发依赖是 `typescript`；`types/node-shims.d.ts` 提供了测试所需的
最小 Node 内置模块类型声明，因此不需要 `@types/node`。

## API

```ts
import { GpaLeaderboard } from './src';

const board = new GpaLeaderboard();
board.upsertGrade('alice', 'c1', '3.50', '2.00');   // 新增；同学生同课程则替换点数和学分
board.removeGrade('alice', 'c1');                    // 移除该课程成绩
board.studentRank('alice');                          // => { studentId, gpa, rank } | null
board.leaderboard(0, 10);                            // => RankEntry[]（零起始偏移分页）
```

- `points` / `credits`：恰好两位小数的十进制字符串（如 `"3.75"`），`credits` 必须大于 0。
- GPA = Σ(点数 × 学分) / Σ学分。排序与并列判断基于未舍入的精确数学值
  （整数百分位 + BigInt 交叉相乘比较，不经过浮点）。
- 展示 GPA 保留两位小数，half-up 舍入。
- 竞赛排名：名次 = 1 + GPA 严格更高的人数；并列同名次，后续名次跳号。
- 榜单按 GPA 降序，精确同分时按 studentId 的 ASCII 字典序升序。
- 没有课程成绩的学生不参与排名；删除最后一门成绩后立即退出榜单。

## 结构

- `src/decimal.ts` — 两位小数字符串解析为整数百分位、精确有理数的 half-up 格式化。
- `src/leaderboard.ts` — `GpaLeaderboard` 主类（四个操作 + 排序与名次计算）。
- `test/leaderboard.test.ts` — 确定性场景：精确并列（总学分不同）、展示相同但原值不同、
  half-up 边界、替换与删除、名次跳号、跨并列组分页、非法输入。
- `test/randomized.test.ts` — 带种子的随机更新序列，逐步与独立参考模型核对
  全部学生名次和各偏移分页，覆盖退出后重新进入、同分组形成与拆散。
