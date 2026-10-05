# cve-matcher

离线 CVE 匹配库（TypeScript）。从本地 JSON 文件加载漏洞库，对一批软件安装记录在内存中完成匹配，供上层终端扫描流程以库形式调用，无接口层、无外部服务依赖。

## 构建与测试

```sh
npm install
npm test        # 编译并运行全部自动化测试
npm run build   # 仅编译到 dist/
```

仅需 Node.js；`typescript` 为唯一开发依赖，声明在 `package.json` 中。

## 使用

```ts
import { loadDatabaseFromFile, matchInstallations } from "cve-matcher";

const db = loadDatabaseFromFile("vulns.json");   // 一次加载，可复用于多批清单
for (const rel of matchInstallations(db, installations)) {
  // rel = { installationId, cveId }，逐条消费，无需保留全部结果
}
```

- `loadDatabase(data)`：从已解析的 JSON 对象加载。
- `matchInstallations(db, records)`：生成器，逐条产出命中关系。输出顺序确定，与输入排列顺序及重复调用无关；同一安装记录对同一 CVE 只产出一次；无命中的记录不产生关系。

## 数据格式

漏洞库 JSON：

```jsonc
{
  "cves": [
    {
      "cveId": "CVE-2024-0001",
      "items": [
        {
          "vendor": "vendor-v",
          "product": "product-p",
          "range": {                                  // 适用区间，上下界均可缺省
            "lower": { "version": "1.2.0", "inclusive": false },
            "upper": { "version": "2.0.0", "inclusive": true }
          },
          "exclusions": [                             // 可选，排除区间，边界规则相同
            { "lower": { "version": "1.5.0", "inclusive": true },
              "upper": { "version": "1.6.0", "inclusive": false } }
          ]
        }
      ]
    }
  ]
}
```

安装记录：`{ id, vendor, product, version }`。版本为三段非负十进制整数（每段 0–65535），按主、次、修订数值比较，不含预发布或构建标记。

命中规则：安装版本落入某适用项区间且不落入该项任何排除区间，即命中该 CVE；排除只影响所属适用项。

## 实现要点

- 版本编码为单个数字（`major·2³² + minor·2¹⁶ + patch`），直接数值比较。
- 加载时把每条适用项的区间减去其排除区间，得到若干有效命中半开区间，按 `厂商+产品` 分组并展开为排序事件流。
- 匹配时对每组按版本升序做扫描线：事件流单调消费，活跃集合即当前命中的 CVE（天然按 CVE 去重），再与该版本下的安装记录两两产出。
- 复杂度：加载 `O(项数·log)`，单批匹配 `O(事件数 + 版本数·log + 关系数)`；热点组（16 万重叠适用项、版本几乎全被排除）同样在线性事件扫描内完成。

实测（M 系列 MacBook，Node 24）：20 万适用项 + 20 万排除区间加载约 0.2s；10 万安装记录的低命中批次约 0.05s、多去重批次（10 万关系）约 0.04s；进程峰值内存约 350MiB，均低于 15s / 8s / 512MiB 的限额。

## 测试

- `test/acceptance.test.ts`：验收规定的小规模精确命中集合、乱序与重复调用一致性、JSON 文件加载。
- `test/semantics.test.ts`：缺省上下界、交叠排除区间、排除的作用域、多终端同版本不合并、版本解析校验。
- `test/hotspot.test.ts`：20 万适用项 + 20 万排除区间、热点组 16 万项 / 8 万记录、低命中与多去重批次的耗时与内存断言。
