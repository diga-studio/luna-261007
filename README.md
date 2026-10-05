# connector-normalize

企业连接器的声明式数据归一化库（TypeScript）。上层传入 JSON 映射定义与源记录，
库提供**定义检查**与**批量转换**两项能力，不留存原始记录或转换结果。

## 快速开始

```bash
npm install
npm test        # 编译并运行全部测试（仅需 Node.js）
npm run build   # 仅编译到 dist/
```

## API

```ts
import { validateDefinition, convertRecords } from "connector-normalize";

const definition = {
  rules: [
    { source: "id", target: "employeeId" },                                  // 原样复制
    { source: "hiredAt", target: "person.hiredAt", transform: { kind: "date" } },
    { source: "status", target: "person.status",
      transform: { kind: "enum", values: ["ACTIVE", "LEFT"] } },
    { source: "payroll.*.gross", target: "entries.*.amount",
      transform: { kind: "unit", numerator: "1", denominator: "100", scale: 2 } },
  ],
};

const check = validateDefinition(definition);   // { ok: true } 或 { ok: false, errors }
if (!check.ok) { /* 整份定义被拒绝，查看 check.errors */ }

const { records, errors } = convertRecords(definition, sourceRecords);
// records: 每条源记录恰好一条输出，顺序不变
// errors:  失败字段列表，含 recordIndex / arrayIndex / sourcePath / targetPath / reason
```

`convertRecords` 在定义非法时抛出错误；建议先调用 `validateDefinition`。

## 规则摘要

- **路径**：点号分隔，可穿过多层对象；`*` 表示数组层（最多一层，源与目标必须同时保留）。
  同一目标数组只能来自同一源数组；目标叶子唯一；目标位置不能兼作叶子/对象/数组容器，
  冲突时定义检查拒绝整份定义。
- **数组**：逐元素对应，不压缩、不重排。源数组缺失/为 `null`/为空数组时，
  目标分别缺失/为 `null`/为空数组；元素没有成功字段时仍保留空对象。
- **叶子**：源缺失则省略目标；显式 `null` 原样保留且不转换；
  单叶子转换失败只省略该叶子并记录错误，其余照常。
- **date**：输入限带 `Z` 或数值偏移的 RFC3339 时间戳，小数秒 0-3 位；
  输出 UTC、固定 3 位小数秒。非法日历日期、闰秒、无时区均失败，不受机器时区影响。
- **enum**：按声明值精确匹配，区分大小写，不做数字/字符串互转。
- **unit**：输入为不含指数的十进制字符串（支持 30 位有效数字、12 位小数）；
  倍率为整数分子/正整数分母；按 0-6 位目标精度做中点取偶舍入（正负数同规则）；
  输出定长小数字符串，负零归一为正零。
- **纯度**：定义与源记录在成功或失败后均不被修改；批次之间无状态，同一输入结果一致。

## 项目结构

- `src/types.ts` — 公共类型
- `src/paths.ts` — 字段路径解析
- `src/validate.ts` — 定义检查（含目标路径前缀树冲突检测）
- `src/date.ts` / `src/enumTransform.ts` / `src/unit.ts` — 三种转换
- `src/convert.ts` — 批量转换引擎
- `test/` — 基于 `node:test` 的自动化测试
