# class-transfer-planner

园所调班排程库（TypeScript，纯内存，无外部服务依赖）。由上层直接调用：
调用方提供班级、儿童及目标分班，库返回一份可逐步执行、全程满足师幼比、
且移动总次数全局最少的调班顺序；不存在合法顺序时明确告知无法完成。

## 规则模型

- 比例类别由调用方按儿童给定：婴儿 1:4，幼儿 1:6，学前儿童 1:10。
- 正式班教师人数固定；混龄班按当前在班儿童中最严格的比例管理，
  允许人数为 `min(20, 教师人数 × 最严格比例)`；空班没有儿童比例限制。
- 初始分班与最终分班由调用方保证合规；初始班与目标相同的儿童不得移动，
  但始终参与人数与比例计算。
- 园所另有一个初始为空的临时交接区：固定 1 名教师，最多容纳 2 名儿童，
  不能作为最终目标。
- 每步交接 1 名儿童：原班 → 目标班（计 1 次），或原班 → 交接区 → 目标班
  （计 2 次）。进入目标班后不得再移动，也不能从交接区返回原班。
  每步完成后所有班级及交接区都必须合规。
- 规划不修改调用方提供的输入数据。

## 使用

```ts
import { planTransfers } from 'class-transfer-planner';

const result = planTransfers({
  classes: [
    { id: 'A', teachers: 1 },
    { id: 'B', teachers: 2 },
  ],
  children: [
    { id: 'c1', category: 'infant', initialClassId: 'A', targetClassId: 'B' },
    // ...
  ],
});

if (result.ok) {
  // result.moves: 按顺序执行的交接动作，总次数全局最少
} else {
  // result.reason: 无法完成的原因
}
```

移动动作有三种：`direct`（原班直接进入目标班）、`toHolding`（原班进入交接区）、
`fromHolding`（交接区进入目标班）。

## 算法

把每名待调班儿童的位置（原班 / 交接区 / 目标班）编码为状态，
在状态空间上做广度优先搜索：每步代价均为 1，
因此首次到达目标状态的路径即为全局最少移动次数；搜索耗尽则判定无法完成。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部自动化测试
npm run build   # 仅编译到 dist/
```

仅依赖 Node.js 与 devDependency 中的 TypeScript，不需要任何其他服务。
