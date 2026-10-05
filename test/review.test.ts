import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DualTrackReview, type Command, type Determination } from "../src/index.js";

/** 以固定纪元为基准构造毫秒级业务时刻。 */
const EPOCH = Date.parse("2026-01-01T00:00:00.000Z");
const at = (day: number, ms = 0): number => EPOCH + day * 86_400_000 + ms;

function withReview(fn: (review: DualTrackReview, dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "dtr-"));
  const dbPath = join(dir, "review.sqlite");
  const review = new DualTrackReview(dbPath);
  try {
    fn(review, dbPath);
  } finally {
    review.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 参考实现：从命令日志独立核算当前有效记录并判定，用于交叉验证。 */
function independentDeterminations(
  commands: readonly Command[],
): Map<string, Determination> {
  interface AppVer { rev: number; loanId: string; voided: boolean; completeAt: number | null; terminatedAt: number | null }
  interface AdvVer { rev: number; loanId: string; voided: boolean; occurredAt: number | null }
  const apps = new Map<string, AppVer>();
  const advs = new Map<string, AdvVer>();
  for (const command of commands) {
    if (command.kind === "upsert-application") {
      const cur = apps.get(command.applicationId);
      if (!cur || command.revision > cur.rev) {
        apps.set(command.applicationId, {
          rev: command.revision, loanId: command.loanId, voided: false,
          completeAt: command.facts.completeAt, terminatedAt: command.facts.terminatedAt,
        });
      }
    } else if (command.kind === "void-application") {
      const cur = apps.get(command.applicationId);
      if (!cur || command.revision > cur.rev) {
        apps.set(command.applicationId, { rev: command.revision, loanId: "", voided: true, completeAt: null, terminatedAt: null });
      }
    } else if (command.kind === "upsert-advancement") {
      const cur = advs.get(command.advancementId);
      if (!cur || command.revision > cur.rev) {
        advs.set(command.advancementId, { rev: command.revision, loanId: command.loanId, voided: false, occurredAt: command.facts.occurredAt });
      }
    } else {
      const cur = advs.get(command.advancementId);
      if (!cur || command.revision > cur.rev) {
        advs.set(command.advancementId, { rev: command.revision, loanId: "", voided: true, occurredAt: null });
      }
    }
  }
  const result = new Map<string, Determination>();
  for (const [id, adv] of advs) {
    if (adv.voided || adv.occurredAt === null) {
      result.set(id, { advancementId: id, active: false, violation: false, protectingApplicationIds: [] });
      continue;
    }
    const protecting = [...apps.entries()]
      .filter(([, app]) =>
        !app.voided && app.loanId === adv.loanId && app.completeAt !== null &&
        adv.occurredAt! >= app.completeAt &&
        (app.terminatedAt === null || adv.occurredAt! < app.terminatedAt))
      .map(([appId]) => appId)
      .sort();
    result.set(id, { advancementId: id, active: true, violation: protecting.length > 0, protectingApplicationIds: protecting });
  }
  return result;
}

test("两份申请重叠且其中一份终止：关闭一份不能消除另一份的保护", () => {
  withReview((review) => {
    review.submit([
      { kind: "upsert-application", applicationId: "A1", revision: 1, loanId: "L1",
        facts: { completeAt: at(10), terminatedAt: at(20) } },
      { kind: "upsert-application", applicationId: "A2", revision: 1, loanId: "L1",
        facts: { completeAt: at(15), terminatedAt: null } },
      { kind: "upsert-advancement", advancementId: "F1", revision: 1, loanId: "L1",
        facts: { occurredAt: at(18) } },
      { kind: "upsert-advancement", advancementId: "F2", revision: 1, loanId: "L1",
        facts: { occurredAt: at(25) } },
    ]);

    // F1 在重叠区间内：同时被 A1、A2 保护，只计一条违规
    const f1 = review.determineAdvancement("F1")!;
    assert.equal(f1.violation, true);
    assert.deepEqual(f1.protectingApplicationIds, ["A1", "A2"]);

    // A1 终止后，F1 仍被 A2 保护（违规不消除）
    review.submit([
      { kind: "void-application", applicationId: "A1", revision: 2 },
    ]);
    const f1After = review.determineAdvancement("F1")!;
    assert.equal(f1After.violation, true);
    assert.deepEqual(f1After.protectingApplicationIds, ["A2"]);

    // F2 在 A1 终止之后、A2 仍待处理：仍违规
    assert.equal(review.determineAdvancement("F2")!.violation, true);

    // A2 也终止后（终止时刻早于两条推进），保护才消失
    review.submit([
      { kind: "upsert-application", applicationId: "A2", revision: 2, loanId: "L1",
        facts: { completeAt: at(15), terminatedAt: at(17) } },
    ]);
    assert.equal(review.determineAdvancement("F1")!.violation, false);
    assert.equal(review.determineAdvancement("F2")!.violation, false);
  });
});

test("保护区间边界：包含齐全时刻、不包含终止时刻，精确到毫秒", () => {
  withReview((review) => {
    review.submit([
      { kind: "upsert-application", applicationId: "A1", revision: 1, loanId: "L1",
        facts: { completeAt: at(10, 500), terminatedAt: at(20, 500) } },
      { kind: "upsert-advancement", advancementId: "at-complete", revision: 1, loanId: "L1",
        facts: { occurredAt: at(10, 500) } },
      { kind: "upsert-advancement", advancementId: "before-complete", revision: 1, loanId: "L1",
        facts: { occurredAt: at(10, 499) } },
      { kind: "upsert-advancement", advancementId: "at-terminate", revision: 1, loanId: "L1",
        facts: { occurredAt: at(20, 500) } },
      { kind: "upsert-advancement", advancementId: "before-terminate", revision: 1, loanId: "L1",
        facts: { occurredAt: at(20, 499) } },
    ]);
    assert.equal(review.determineAdvancement("at-complete")!.violation, true);
    assert.equal(review.determineAdvancement("before-complete")!.violation, false);
    assert.equal(review.determineAdvancement("at-terminate")!.violation, false);
    assert.equal(review.determineAdvancement("before-terminate")!.violation, true);
  });
});

test("迟到更正补出历史违规，随后被高版本作废撤除", () => {
  withReview((review) => {
    // 初始：推进时刻之前没有完整申请，无违规
    review.submit([
      { kind: "upsert-advancement", advancementId: "F1", revision: 1, loanId: "L1",
        facts: { occurredAt: at(30) } },
      { kind: "upsert-application", applicationId: "A1", revision: 1, loanId: "L1",
        facts: { completeAt: at(40), terminatedAt: null } },
    ]);
    assert.equal(review.determineAdvancement("F1")!.violation, false);

    // 迟到的更正：资料齐全时刻实际更早，补出历史违规
    review.submit([
      { kind: "upsert-application", applicationId: "A1", revision: 2, loanId: "L1",
        facts: { completeAt: at(25), terminatedAt: null } },
    ]);
    const corrected = review.determineAdvancement("F1")!;
    assert.equal(corrected.violation, true);
    assert.deepEqual(corrected.protectingApplicationIds, ["A1"]);

    // 高版本作废申请：违规撤除
    review.submit([{ kind: "void-application", applicationId: "A1", revision: 3 }]);
    assert.equal(review.determineAdvancement("F1")!.violation, false);

    // 迟到的旧版本（rev 2）不能复活记录
    review.submit([
      { kind: "upsert-application", applicationId: "A1", revision: 2, loanId: "L1",
        facts: { completeAt: at(25), terminatedAt: null } },
    ]);
    assert.equal(review.determineAdvancement("F1")!.violation, false);
  });
});

test("推进自身被更正与作废；作废占用修订号", () => {
  withReview((review) => {
    review.submit([
      { kind: "upsert-application", applicationId: "A1", revision: 1, loanId: "L1",
        facts: { completeAt: at(10), terminatedAt: at(20) } },
      { kind: "upsert-advancement", advancementId: "F1", revision: 1, loanId: "L1",
        facts: { occurredAt: at(15) } },
    ]);
    assert.equal(review.determineAdvancement("F1")!.violation, true);

    // 更正推进的业务时刻到保护区间之外
    review.submit([
      { kind: "upsert-advancement", advancementId: "F1", revision: 2, loanId: "L1",
        facts: { occurredAt: at(25) } },
    ]);
    assert.equal(review.determineAdvancement("F1")!.violation, false);

    // 相同修订号重复投递不改变结果
    review.submit([
      { kind: "upsert-advancement", advancementId: "F1", revision: 2, loanId: "L1",
        facts: { occurredAt: at(15) } },
    ]);
    assert.equal(review.determineAdvancement("F1")!.violation, false);

    // 作废推进
    review.submit([{ kind: "void-advancement", advancementId: "F1", revision: 3 }]);
    const voided = review.determineAdvancement("F1")!;
    assert.equal(voided.active, false);
    assert.equal(voided.violation, false);

    // 旧版本不能复活已作废的推进
    review.submit([
      { kind: "upsert-advancement", advancementId: "F1", revision: 2, loanId: "L1",
        facts: { occurredAt: at(15) } },
    ]);
    assert.equal(review.determineAdvancement("F1")!.active, false);
  });
});

test("只与同一贷款的申请比较；可查询单笔贷款全部判定", () => {
  withReview((review) => {
    review.submit([
      { kind: "upsert-application", applicationId: "A1", revision: 1, loanId: "L1",
        facts: { completeAt: at(10), terminatedAt: null } },
      { kind: "upsert-advancement", advancementId: "F-L1", revision: 1, loanId: "L1",
        facts: { occurredAt: at(15) } },
      { kind: "upsert-advancement", advancementId: "F-L2", revision: 1, loanId: "L2",
        facts: { occurredAt: at(15) } },
    ]);
    assert.equal(review.determineAdvancement("F-L1")!.violation, true);
    assert.equal(review.determineAdvancement("F-L2")!.violation, false);

    const loanDeterminations = review.determineLoan("L1");
    assert.equal(loanDeterminations.length, 1);
    assert.equal(loanDeterminations[0]!.advancementId, "F-L1");

    assert.equal(review.determineAdvancement("missing"), null);
  });
});

test("持久化：重新打开数据库后判定一致", () => {
  withReview((review, dbPath) => {
    review.submit([
      { kind: "upsert-application", applicationId: "A1", revision: 1, loanId: "L1",
        facts: { completeAt: at(10), terminatedAt: null } },
      { kind: "upsert-advancement", advancementId: "F1", revision: 1, loanId: "L1",
        facts: { occurredAt: at(15) } },
    ]);
    review.close();

    const reopened = new DualTrackReview(dbPath);
    try {
      assert.equal(reopened.determineAdvancement("F1")!.violation, true);
    } finally {
      reopened.close();
    }
  });
});

test("与按全部当前有效记录独立核算的结果一致（乱序批量投递）", () => {
  // 故意乱序、掺杂重复与旧版本的命令流
  const commands: Command[] = [
    { kind: "upsert-advancement", advancementId: "F1", revision: 2, loanId: "L1", facts: { occurredAt: at(12) } },
    { kind: "upsert-application", applicationId: "A1", revision: 3, loanId: "L1", facts: { completeAt: at(10), terminatedAt: at(30) } },
    { kind: "upsert-advancement", advancementId: "F1", revision: 1, loanId: "L1", facts: { occurredAt: at(50) } }, // 旧版本，应被忽略
    { kind: "upsert-application", applicationId: "A1", revision: 1, loanId: "L1", facts: { completeAt: at(100), terminatedAt: null } }, // 旧版本
    { kind: "upsert-application", applicationId: "A2", revision: 1, loanId: "L1", facts: { completeAt: at(5), terminatedAt: null } },
    { kind: "void-application", applicationId: "A2", revision: 2 },
    { kind: "upsert-application", applicationId: "A2", revision: 1, loanId: "L1", facts: { completeAt: at(1), terminatedAt: null } }, // 重复旧版本
    { kind: "upsert-advancement", advancementId: "F2", revision: 1, loanId: "L1", facts: { occurredAt: at(35) } },
    { kind: "upsert-advancement", advancementId: "F3", revision: 1, loanId: "L1", facts: { occurredAt: at(15) } },
    { kind: "void-advancement", advancementId: "F3", revision: 2 },
    { kind: "upsert-application", applicationId: "A3", revision: 1, loanId: "L2", facts: { completeAt: at(1), terminatedAt: null } },
    { kind: "upsert-advancement", advancementId: "F4", revision: 1, loanId: "L2", facts: { occurredAt: at(15) } },
  ];
  withReview((review) => {
    review.submit(commands);
    const expected = independentDeterminations(commands);
    for (const [id, want] of expected) {
      assert.deepEqual(review.determineAdvancement(id), want, `判定不一致: ${id}`);
    }
    // 贷款级查询也应一致
    const loanL1 = review.determineLoan("L1");
    const wantL1 = [...expected.values()].filter((d) =>
      ["F1", "F2", "F3"].includes(d.advancementId));
    assert.deepEqual(
      loanL1.map((d) => d.advancementId).sort(),
      wantL1.map((d) => d.advancementId).sort(),
    );
  });
});
