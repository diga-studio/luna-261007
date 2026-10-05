# custody-seal

证据保管链封存与报告库（TypeScript）。由上层直接调用，事件与封存数据持久化在本地文件中，无任何外部服务依赖。

## 功能

- **追加保管事件**：`appendEvent` 追加事件（记录标识、UTC 秒级时间、操作者、正文），每次追加获得唯一递增的全局序号（从 1 开始）。已追加事件不可修改、不可删除；身份确认与事件采集由上层完成。
- **封存账册**：`seal` 一次性封存，之后账册只读。输出 **76 字节**（≤128）的封存凭证，由调用方另行保管。凭证对封存时全部事件的内容、追加顺序和总数作密码学绑定。
- **生成报告**：`generateReport(recordId)` 生成单条记录的报告，包含该记录全部事件（按时间升序、同秒按全局序号），不含其他记录事件；无匹配记录时生成可验真的空报告。关闭重开后仍可生成。
- **独立验真**：`verifyReport(credential, recordId, report)` 只凭记录标识、可信凭证与报告判断，不读取账册、不持有秘密密钥。

## 使用

```ts
import { CustodyLedger, verifyReport } from 'custody-seal';

// 打开（或创建）账册
const ledger = CustodyLedger.open('/path/to/ledger-dir');

// 追加事件（timestamp 省略时取当前 UTC 秒）
const seq = ledger.appendEvent({
  recordId: 'EV-2026-0001',
  timestamp: 1760000000,       // 可选，UTC 秒
  actor: 'officer-zhang',
  body: '登记入库',             // string 或 Uint8Array
});

// 封存（只能一次），凭证另行保管
const credential = ledger.seal();   // Uint8Array，76 字节
ledger.close();

// 之后：重开并生成报告
const reopened = CustodyLedger.open('/path/to/ledger-dir');
const report = reopened.generateReport('EV-2026-0001');
reopened.close();

// 审查方独立验真（不需要账册文件）
const ok = verifyReport(credential, 'EV-2026-0001', report);
```

## 密码学构造

全部基于 SHA-256（带领域分离标签），无秘密密钥：

- **全局链**：`G₀ = H(genesis)`，`Gᵢ = H(chain ‖ Gᵢ₋₁ ‖ Cᵢ)`，其中 `Cᵢ = H(event ‖ encode(eventᵢ))`。凭证中的 `globalHead = Gₙ` 与 `eventCount = n` 绑定全部事件的内容、顺序与总数。
- **记录链**：每个记录的事件按追加序另成一条链 `Rⱼ = H(record ‖ Rⱼ₋₁ ‖ C)`，链头即该记录的完整历史承诺。
- **记录目录**：所有 `(H(recordId), recordHead)` 按键排序构成 Merkle 树，根写入凭证。纳入证明给出目标记录的链头；排除证明（空报告）给出排序相邻的左右叶子及其路径，证明该记录不存在。
- **凭证**（76 字节）：`magic(4) ‖ eventCount(8) ‖ globalHead(32) ‖ recordRoot(32)`。

验真时：纳入证明确认 `recordHead` 属于凭证对应账册；用报告中的事件按序号重放记录链，结果必须等于 `recordHead`——事件内容、集合、顺序有任何增删改换都会失配。报告事件同时必须按 `(timestamp, seq)` 升序。

账册文件、报告、校验材料都可被任意修改：改动 `events.log` 会使记录链重放失配（库在生成报告前也会自检并拒绝产出）；改动 `seal.bin` 会使证明无法对到审查方持有的凭证。

## 存储格式（账册目录）

- `events.log`：追加式二进制事件日志，`totalLen u32 ‖ seq u64 ‖ timestamp u64 ‖ ridLen u32 rid ‖ actorLen u32 actor ‖ bodyLen u32 body`。
- `seal.bin`：一次性写入的封存产物：文件头（计数、全局链头、记录树根）‖ 记录段（按键序：rid、key、链头、序号区间）‖ 序号表 ‖ 事件偏移表 ‖ Merkle 层字节。重开时按需分段读取，不整载入内存。

## 性能（100 万事件 / 10 万记录，目标记录 100 条 × 128B 正文）

由 `test/perf.test.ts` 自动验收（全新进程，从账册未打开到两份报告生成完毕）：

- 打开 + 初始化 + 生成报告总耗时：实测约 20 ms（上限 2 s）
- 额外峰值工作内存：实测约 30 MiB（上限 64 MiB）
- 每份报告校验材料：实测约 3–11 KiB（上限 64 KiB）
- 封存凭证：76 B（上限 128 B）

## 构建与测试

只依赖 Node.js（≥18）与 npm 开发依赖（typescript、@types/node）：

```sh
npm install
npm test
```

测试覆盖：多记录交错追加与大量同秒事件、报告与独立遍历一致、非空/空报告验真、各类篡改（删首尾/中间事件、交换同秒事件、替换正文、拼入其他记录材料、伪报为空、错凭证）、账册文件改动后的拒绝行为、关闭重开持久化，以及 100 万事件规模下的耗时/内存/校验材料上限。
