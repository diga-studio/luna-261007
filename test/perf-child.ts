// 性能测量子进程：从账册未打开状态开始，测量 打开+生成报告 的耗时与峰值内存增量。
// 用法: node perf-child.js <dbPath> <recordId> <credentialHex>
import { Ledger, verifyReport } from "../src/index.js";

function maxRssBytes(): number {
  const raw = process.resourceUsage().maxRSS;
  // macOS 的 ru_maxrss 单位是字节，Linux 是 KiB。
  return process.platform === "darwin" ? raw : raw * 1024;
}

function main(): void {
  const [dbPath, recordId, credentialHex] = process.argv.slice(2);
  if (!dbPath || !recordId || !credentialHex) {
    throw new Error("usage: perf-child <dbPath> <recordId> <credentialHex>");
  }
  const credential = Buffer.from(credentialHex, "hex");

  const rssBefore = maxRssBytes();
  const t0 = process.hrtime.bigint();

  const ledger = Ledger.open(dbPath);
  const report = ledger.generateReport(recordId);
  ledger.close();

  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const rssDelta = maxRssBytes() - rssBefore;

  const proofBytes = Buffer.byteLength(JSON.stringify(report.proof), "utf8");
  const verified = verifyReport(credential, recordId, report);

  console.log(
    JSON.stringify({ elapsedMs, rssDeltaBytes: rssDelta, proofBytes, verified }),
  );
}

main();
