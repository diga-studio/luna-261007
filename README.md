# prototype-playback

原型回放引擎（TypeScript 库）。由上层设计工具调用，不含界面与接口层。
项目定义为 JSON，会话状态保存在进程内存，时间完全由调用方给定，不依赖真实等待。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部测试
npm run build   # 仅编译到 dist/
```

## 使用

```ts
import { PlaybackEngine } from "prototype-playback";

const engine = new PlaybackEngine(project); // 项目定义在构造时校验，非法即抛错
const session = engine.createSession(0);    // 从初始屏幕与初始变量开始

engine.tap(session, "login", 1200);         // 投递带时间戳的点按
engine.advanceTo(session, 60_000);          // 推进到指定逻辑时间
const state = engine.getState(session);     // { currentScreen, variables, history, expired }
```

`tap` 与 `advanceTo` 返回本次实际触发规则的记录（含逻辑触发时间、所在屏幕、命中分支），
按触发顺序排列；未命中分支的规则与失效的计时不出现在记录中。

## 项目定义

```jsonc
{
  "initialScreen": "home",
  "variables": [
    { "name": "count", "type": "number", "initial": 0 }   // string | number | boolean
  ],
  "screens": [
    {
      "name": "home",
      "rules": [
        {
          "trigger": { "kind": "tap", "name": "go" },
          // 或 { "kind": "timer", "delayMs": 1000 }（100 ~ 10000 毫秒）
          "branches": [
            {
              "conditions": [
                { "variable": "count", "op": "lt", "value": 3 }
                // op: eq | neq（同类型）| gt | gte | lt | lte（仅数字）
              ],
              "actions": [
                { "kind": "set", "variable": "count", "value": 0 },
                { "kind": "add", "variable": "count", "delta": 1 },   // 仅数字
                { "kind": "navigate", "screen": "detail" },
                { "kind": "back" }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

## 语义要点

- **分支**：触发时按当时变量选择首个全部条件满足的分支；无满足则无动作。动作按序执行，期间不重新选择分支。
- **计时**：每次进入屏幕重新计时；本轮进入中每条计时最多触发一次（无分支满足也不重试）；离开屏幕后未触发的计时全部失效；导航到当前屏幕同样按重新进入处理。
- **推进**：按实际到点处理全部计时，包括中途新进入屏幕产生的计时（从实际进入时刻起算）；同一时刻到点按配置顺序，前一条造成离开后原屏幕剩余计时不再触发。
- **点按**：先处理同刻及之前到点的计时，再匹配当时当前屏幕上的点按规则（配置顺序，离开后停止）；同一时间戳的多次点按按调用顺序处理。
- **导航/返回**：导航压入返回历史（最多 20 项，满时丢弃最早项）；返回弹出最近一项，不压历史、不恢复变量；空历史返回无动作。
- **过期**：创建会话初始化活动时间；点按（含未匹配）刷新活动时间，计时/推进/查看不刷新；连续 30 分钟无点按即过期，到期优先于同刻计时与点按；过期后不可恢复，状态不再改变。
- **时间**：调用串行、时间戳不递减（递减会抛错）；各会话互不影响。

## 目录结构

- `src/types.ts` — 项目定义与公开 API 类型
- `src/validate.ts` — 项目定义校验（200 屏幕 / 50 变量上限、延迟范围、类型匹配等）
- `src/session.ts` — 会话状态机：计时调度、分支执行、历史与过期
- `src/engine.ts` — 多会话管理门面
- `test/` — node:test 自动化测试（含快进一致性、同刻计时、过期边界、性能用例）
