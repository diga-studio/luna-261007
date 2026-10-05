# cve-matcher

离线 CVE 匹配库：从 CVE 漏洞库与终端软件清单均来自本地 JSON 文件，加载后在内存中完成匹配，供上层终端扫描流程直接调用（无接口层、无网络、无外部服务）。

## 构建与测试

```sh
npm install
npm test        # 等价于 tsc && node --test "build/test/*.test.js"
npm run build   # 仅编译到 build/
```

## API

```ts
import {
  loadDatabaseFile,     // 从本地 JSON 文件加载漏洞库并建立索引
  buildDatabase,        // 从已解析的对象构建索引（便于测试）
  loadInventoryFile,    // 从本地 JSON 文件加载一批安装记录
  matchInventory,       // 返回全部命中关系数组
  matchInventoryIter,   // 逐条产出命中关系的生成器（流式消费）
} from "cve-matcher";

const db = loadDatabaseFile("vulns.json");      // 加载一次可处理多批清单
const records = loadInventoryFile("inventory.json");
const relations = matchInventory(db, records);  // [{ recordId, cveId }, ...]
```

- 命中关系按 `(recordId, cveId)` 字典序排序，与输入排列顺序、重复调用无关。
- 同一安装记录命中同一 CVE 的多个适用项只返回一次；不同安装记录分别返回。
- 匹配期间漏洞库只读，不要求增量更新或崩溃恢复。

## 文件格式

漏洞库 `vulns.json`：

```json
{
  "cves": [
    {
      "id": "CVE-2024-000",
      "items": []
    }
  ]
}
```

每个适用项 `items`：

```json
{
  "vendor": "acme",
  "product": "app",
  "range": {
    "lower": { "version": "1.2.0", "inclusive": false },
    "upper": { "version": "2.0.0", "inclusive": true }
  },
  "exclusions": [
    {
      "lower": { "version": "1.5.0", "inclusive": true },
      "upper": { "version": "1.6.0", "inclusive": false }
    }
  ]
}
```

- `lower` / `upper` 均可缺省，表示该方向无界；`exclusions` 可缺省。
- 版本固定为三段非负十进制整数（每段 0–65535），按主、次、修订数值比较。
- 安装版本落入适用区间且不落入该项任何排除区间，才算命中该项；排除只影响所属适用项。

清单 `inventory.json`：

```json
{
  "records": [
    { "id": "host-1", "vendor": "acme", "product": "app", "version": "1.5.0" }
  ]
}
```

## 实现要点

- 版本编码为单个安全整数（`major·2³² + minor·2¹⁶ + patch`），区间比较即整数比较。
- 加载时按 `(vendor, product)` 分组，每个适用项先扣除排除区间得到命中区间，
  再展开为扫描线事件（类型化数组存储，20 万适用项 + 20 万排除区间加载 < 1 秒）。
- 匹配时对每组安装记录按版本排序后扫描线求交，活跃集合按 CVE 计数去重，
  代价与命中关系数成正比；被排除而几乎无命中的热点批次同样在线性时间内完成。
