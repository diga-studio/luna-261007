# evidence-custody-ledger

证据保管链封存与报告库（TypeScript）。由上层直接调用，事件与封存数据持久化在本地 SQLite 文件（`node:sqlite`，无原生依赖、无外部服务）。

## 功能

- **追加保管事件**：事件含记录标识、UTC 秒级时间、操作者、正文；每次追加获得唯一递增的全局序号（从 1 开始）。已追加事件不可修改、不可删除。
- **封存账册**：一本账册只封存一次，封存后只读。输出 ≤128 字节的凭证（实际 43 字节），由调用方另行保管。
- **生成报告**：针对单个记录标识，输出该记录的全部事件（按时间升序、同秒按全局序号），附带校验材料；无匹配事件时生成可验真的空报告。关闭重开后仍可生成。
- **独立验真**：接收方仅凭可信凭证 + 记录标识 + 报告即可验真，不读账册、不持有秘密密钥。

## 密码学构造

- 每个记录维护一条哈希链：`head = H("EC1/CH" ‖ head_prev ‖ H("EC1/EV" ‖ key ‖ seq ‖ ts ‖ len‖operator ‖ len‖body))`，其中 `key = H("EC1/ID" ‖ recordId)`。链头绑定该记录全部事件的内容与追加顺序。
- 封存时对所有记录计算目录叶 `H("EC1/LF" ‖ key ‖ count ‖ head)`，按键升序构建 Merkle 树。凭证 = `"EC1" ‖ totalCount(8B) ‖ merkleRoot(32B)`，对封存时全部事件的内容、追加顺序和总数作密码学绑定。
- 非空报告携带目标记录叶的 Merkle 包含证明；空报告携带相邻叶的不存在证明（有序树 + 邻居证明）。校验材料在 10 万记录规模下约 1~3 KiB，远低于 64 KiB 上限。
- 账册文件、报告、校验材料都可被攻击者修改；只有凭证可信。任何对事件或目录的篡改都会使验真失败。

## API

```ts
import { Ledger, verifyReport } from "evidence-custody-ledger";

const ledger = Ledger.open("case.db");          // 不存在则创建
const seq = ledger.appendEvent({                 // 追加单条（或 appendEvents 批量）
  recordId: "exhibit-001",
  timestamp: 1_700_000_000,                      // UTC 秒
  operator: "officer-a",
  body: "sealed into bag",
});
const credential: Uint8Array = ledger.seal();    // 封存，输出 ≤128 字节凭证
ledger.close();

const reopened = Ledger.open("case.db");         // 关闭重开
const report = reopened.generateReport("exhibit-001");
reopened.close();

// 审查方独立验真（不需要账册文件）
const ok = verifyReport(credential, "exhibit-001", report);
```

## 构建与测试

要求 Node.js ≥ 22.5（内置 `node:sqlite`）。无运行时依赖，开发依赖仅 `typescript`。

```sh
npm install
npm test
```

测试覆盖：交错追加与大量同秒事件、报告与独立遍历一致性、删改/交换/拼接/伪报/错凭证等篡改场景、账册文件被改动后的报告验真失败，以及 100 万事件 / 10 万记录规模下重开后生成报告的耗时（≤2s）、额外峰值内存（≤64 MiB）与校验材料大小（≤64 KiB）。
