# connector-normalizer

企业连接器的声明式数据归一化库。上层传入 JSON 映射定义与源记录批次，库提供两项能力：

- `checkDefinition(definition)`：定义检查。发现冲突或非法项时整体拒绝，返回全部问题。
- `transformBatch(definition, records)`：批量转换。每条源记录恰好产生一条输出，顺序不变。

库不留存原始记录或转换结果，批次间无共享状态，且不修改传入的定义与记录。

## 映射定义

```jsonc
{
  "rules": [
    // 原样复制
    { "source": ["id"], "target": ["id"], "transform": { "kind": "copy" } },
    // 日期：RFC3339（须带 Z 或数值偏移，小数秒 0-3 位）-> UTC、固定 3 位小数秒
    { "source": ["profile", "hiredAt"], "target": ["profile", "hiredAt"], "transform": { "kind": "date" } },
    // 枚举：精确匹配、区分大小写
    { "source": ["level"], "target": ["level"], "transform": { "kind": "enum", "values": ["L1", "L2"] } },
    // 单位换算：十进制字符串 × 分子 / 分母，按 scale 位小数银行家舍入
    {
      "source": ["items", "*", "qty"],
      "target": ["items", "*", "qty"],
      "transform": { "kind": "unit", "numerator": "1", "denominator": "1000", "scale": 3 }
    }
  ]
}
```

规则要点：

- 仅映射标量叶子；未声明的字段不进入输出。
- 路径可穿过多层对象，最多穿过一层对象数组（用 `"*"` 段表示）；涉及数组时源与目标都必须保留该数组层级。
- 同一目标数组只能来自同一源数组；同一目标叶子只能由一条规则产生；同一目标位置不能兼作叶子、对象或数组容器。冲突时 `checkDefinition` 整体拒绝。

## 转换语义

- 源叶子缺失时省略目标；显式 `null` 原样保留且不执行转换。
- 源数组缺失 / 为 `null` / 为空数组时，目标分别缺失 / 为 `null` / 为空数组；数组逐元素对应，元素没有成功字段时仍保留空对象。
- 单个叶子转换失败只省略该目标叶子，错误中包含 `recordIndex`、`arrayIndex`（非数组路径为 `null`）与目标路径，其余字段与记录照常转换。

## 构建与测试

```sh
npm install
npm test
```

仅依赖 Node.js（>=18）与 devDependency 中的 TypeScript。
