# prototype-playback

确定性原型回放引擎（TypeScript，无界面/接口层）。项目以 JSON 定义，会话状态保存在进程内存，时间完全由调用方给定，不依赖真实时钟，回放过程可重复、可解释。

## 使用

```bash
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

```ts
import { createSession } from 'prototype-playback';

const session = createSession(project, /* now */ 0);
session.tap(1500, 'login');        // 投递带时间戳的点按
session.advanceTo(60_000);         // 快进到指定逻辑时间
const state = session.getState();  // { screen, variables, history, expired }
```

## 项目定义（JSON）

- `initialScreen`：初始屏幕名。
- `variables`：`{ name, type: 'string'|'number'|'boolean', initial }`。
- `screens`：`{ name, rules }`，规则含触发器与有序分支：
  - 触发器：`{ kind: 'tap', name }` 或 `{ kind: 'timer', delayMs }`（100–10000 整数）。
  - 分支：`{ conditions, actions }`，条件全部成立才命中，按数组顺序取首个命中分支。
  - 条件：`{ variable, op: 'eq', value }`（同类型相等）或 `{ variable, op: 'gt|gte|lt|lte', value }`（数字）。
  - 动作：`set`（赋常量）、`adjust`（数字增减）、`navigate` / `back`（须为分支最后一个动作）。

`validateProject(project)` 在创建会话前校验定义，非法即抛错。

## 回放语义

- **计时**：每次进入屏幕重新计时；离开（含自导航）使未触发的计时失效；每条计时规则每次进入最多触发一次，无分支满足也不重试。
- **推进**：`advanceTo(t)` 按实际到点时刻处理途中全部计时，包括中途新进入屏幕产生的计时（从实际进入时刻起算）；同刻计时按配置顺序，前者导致离开后原屏幕剩余计时不再触发。
- **点按**：先处理不晚于点按时间戳的计时，再匹配当时当前屏幕上首个同名点按规则；未匹配无动作（但仍刷新活动时间）；同刻多次点按按调用顺序处理。
- **导航/返回**：导航将当前屏幕入返回历史（上限 20，满则丢弃最早项）后进入目标；返回取最近一项进入，不回填历史、不恢复变量；空历史返回无动作。
- **过期**：创建会话初始化活动时间，点按（含未匹配）刷新；连续 30 分钟（`SESSION_TTL_MS`）无点按即过期。到期优先于同刻计时与点按；过期不可逆，状态不再改变。计时、推进、查看均不刷新活动时间。
- **记录**：每次 `tap` / `advanceTo` 返回 `fired`，按顺序记录实际触发的规则（逻辑时间、屏幕、规则下标、触发方式、命中分支；无分支满足时 `branchIndex` 为 `null`）。失效计时不出现在记录中。

## 约束

- 调用串行、时间戳不递减（引擎会校验并抛错）。
- 不持久化、不依赖外部服务；规模按 200 屏幕 / 50 变量设计，含 10000 次计时触发的 30 分钟快进远低于 2 秒。
