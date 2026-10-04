# class-transfer-planner

园所调班排程库（TypeScript，纯内存，无外部服务依赖）。由上层直接调用：
调用方提供班级、儿童及目标分班，库返回一份可逐步执行、全程满足师幼比、
且移动总次数全局最少的调班顺序；不存在合法顺序时明确告知无法完成。

## 规则模型

- 比例类别由调用方直接给定：婴儿 `infant` 4 人/教师，幼儿 `toddler` 6 人/教师，
  学前儿童 `preschool` 10 人/教师。正式班教师人数固定。
- 混龄班按当前在班儿童中最严格的比例管理，允许人数为
  `min(20, 教师人数 × 最严格比例)`；空班没有儿童比例限制。
- 初始分班与最终分班均保证合规；初始班级与目标相同的儿童不得移动，
  但始终参与人数与比例计算。
- 临时交接区初始为空，固定 1 名教师，最多容纳 2 名儿童；不能作为最终目标。
- 每一步交接 1 名儿童：原班 → 目标班（计 1 次），或原班 → 交接区 → 目标班
  （计 2 次）。进入目标班后不得再移动，不能从交接区返回原班。
  每步完成后所有班级及交接区都必须合规。

## 安装与测试

```sh
npm install
npm test
npm run build   # 产出 dist/（ESM + .d.ts）
```

## API

```ts
import { planTransfers, verifyMoves, TRANSFER_AREA_ID } from "class-transfer-planner";

const result = planTransfers({
  classes: [
    { id: "A", teachers: 1 },
    { id: "B", teachers: 1 },
  ],
  children: [
    { id: "c1", category: "infant", initialClassId: "A", targetClassId: "B" },
    // ...
  ],
});

if (result.ok) {
  // result.moves: Move[]，全局最少移动次数的完整顺序
  // Move = { childId, from, to }；from/to 为班级 id 或 TRANSFER_AREA_ID
  const check = verifyMoves(input, result.moves); // { ok: true }
} else {
  // result.reason: 无法完成的原因（即使初始与最终分班各自合规）
}
```

- `planTransfers(input, options?)`：BFS 搜索，返回全局最少移动顺序；
  `options.maxStates` 为搜索状态数安全上限（默认 2,000,000），
  触限时返回 `ok: false` 并注明并非不可行性的证明。
- `verifyMoves(input, moves)`：逐步回放移动序列，校验全部规则与最终分班。
- 规划不会修改调用方提供的任何输入数据。

## 目录结构

- `src/types.ts` — 公开类型与常量（比例、容量、交接区 id）
- `src/compliance.ts` — 班级/交接区合规判定
- `src/planner.ts` — 最少移动排程（按「原班/目标班/类别」分组的 BFS）
- `src/verify.ts` — 移动序列逐步校验
- `tests/` — vitest 自动化测试
