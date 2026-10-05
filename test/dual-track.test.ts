import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DualTrackReview } from "../src/index.js";
import type { ApplicationRevision, AdvancementRevision } from "../src/index.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function app(partial: Partial<ApplicationRevision> & Pick<ApplicationRevision, "id" | "loanId" | "revision">): ApplicationRevision {
  return { completeAt: T0, terminatedAt: null, voided: false, ...partial };
}

function adv(partial: Partial<AdvancementRevision> & Pick<AdvancementRevision, "id" | "loanId" | "revision">): AdvancementRevision {
  return { occurredAt: T0, voided: false, ...partial };
}

test("保护区间边界：含齐全时刻，不含终止时刻，未齐全不保护", () => {
  const lib = new DualTrackReview(":memory:");
  lib.submitApplications([
    app({ id: "A1", loanId: "L1", revision: 1, completeAt: T0 + DAY, terminatedAt: T0 + 10 * DAY }),
  ]);
  lib.submitAdvancements([
    adv({ id: "F-before", loanId: "L1", revision: 1, occurredAt: T0 }), // 齐全前
    adv({ id: "F-start", loanId: "L1", revision: 1, occurredAt: T0 + DAY }), // 齐全时刻（含）
    adv({ id: "F-mid", loanId: "L1", revision: 1, occurredAt: T0 + 5 * DAY }),
    adv({ id: "F-end", loanId: "L1", revision: 1, occurredAt: T0 + 10 * DAY }), // 终止时刻（不含）
    adv({ id: "F-after", loanId: "L1", revision: 1, occurredAt: T0 + 11 * DAY }),
  ]);
  assert.equal(lib.checkAdvancement("F-before").violation, false);
  assert.equal(lib.checkAdvancement("F-start").violation, true);
  assert.equal(lib.checkAdvancement("F-mid").violation, true);
  assert.equal(lib.checkAdvancement("F-end").violation, false);
  assert.equal(lib.checkAdvancement("F-after").violation, false);
  lib.close();
});

test("两份申请重叠且其中一份终止：关闭一份不能消除另一份的保护", () => {
  const lib = new DualTrackReview(":memory:");
  lib.submitApplications([
    app({ id: "A1", loanId: "L1", revision: 1, completeAt: T0, terminatedAt: T0 + 5 * DAY }),
    app({ id: "A2", loanId: "L1", revision: 1, completeAt: T0 + 2 * DAY, terminatedAt: null }),
  ]);
  lib.submitAdvancements([
    adv({ id: "F1", loanId: "L1", revision: 1, occurredAt: T0 + 3 * DAY }), // 两份重叠保护
    adv({ id: "F2", loanId: "L1", revision: 1, occurredAt: T0 + 6 * DAY }), // 仅 A2 保护
  ]);
  assert.deepEqual(lib.checkAdvancement("F1").protectedBy, ["A1", "A2"]);
  assert.deepEqual(lib.checkAdvancement("F2").protectedBy, ["A2"]);

  // A1 终止提前到重叠期内：F1 仍被 A2 保护，一条推进只计一条违规
  lib.submitApplications([
    app({ id: "A1", loanId: "L1", revision: 2, completeAt: T0, terminatedAt: T0 + 3 * DAY }),
  ]);
  const v1 = lib.checkAdvancement("F1");
  assert.equal(v1.violation, true);
  assert.deepEqual(v1.protectedBy, ["A2"]);

  // A2 也终止后，F1 才不再违规
  lib.submitApplications([
    app({ id: "A2", loanId: "L1", revision: 2, completeAt: T0 + 2 * DAY, terminatedAt: T0 + 3 * DAY }),
  ]);
  assert.equal(lib.checkAdvancement("F1").violation, false);
  lib.close();
});

test("迟到更正补出历史违规，随后被高版本作废撤除", () => {
  const lib = new DualTrackReview(":memory:");
  // 推进先登记，当时没有申请，无告警
  lib.submitAdvancements([adv({ id: "F1", loanId: "L1", revision: 1, occurredAt: T0 + 3 * DAY })]);
  assert.equal(lib.checkAdvancement("F1").violation, false);

  // 申请迟报：齐全时刻早于推进时刻，补出历史违规
  lib.submitApplications([
    app({ id: "A1", loanId: "L1", revision: 1, completeAt: T0, terminatedAt: null }),
  ]);
  assert.equal(lib.checkAdvancement("F1").violation, true);

  // 高版本作废申请，违规撤除
  lib.submitApplications([
    app({ id: "A1", loanId: "L1", revision: 2, completeAt: T0, terminatedAt: null, voided: true }),
  ]);
  assert.equal(lib.checkAdvancement("F1").violation, false);

  // 迟到的旧版本不能复活记录
  lib.submitApplications([
    app({ id: "A1", loanId: "L1", revision: 1, completeAt: T0, terminatedAt: null }),
  ]);
  assert.equal(lib.checkAdvancement("F1").violation, false);
  lib.close();
});

test("相同或更低修订号的重复投递不改变结果", () => {
  const lib = new DualTrackReview(":memory:");
  lib.submitApplications([
    app({ id: "A1", loanId: "L1", revision: 5, completeAt: T0 + 10 * DAY, terminatedAt: null }),
  ]);
  // 相同修订号、不同内容：忽略
  lib.submitApplications([
    app({ id: "A1", loanId: "L1", revision: 5, completeAt: T0, terminatedAt: null }),
  ]);
  // 更低修订号：忽略
  lib.submitApplications([
    app({ id: "A1", loanId: "L1", revision: 3, completeAt: T0, terminatedAt: null }),
  ]);
  lib.submitAdvancements([adv({ id: "F1", loanId: "L1", revision: 1, occurredAt: T0 + 5 * DAY })]);
  assert.equal(lib.checkAdvancement("F1").violation, false);
  lib.close();
});

test("推进自身被更正或作废后判定随之更新", () => {
  const lib = new DualTrackReview(":memory:");
  lib.submitApplications([app({ id: "A1", loanId: "L1", revision: 1, completeAt: T0, terminatedAt: T0 + 10 * DAY })]);
  lib.submitAdvancements([adv({ id: "F1", loanId: "L1", revision: 1, occurredAt: T0 + 20 * DAY })]);
  assert.equal(lib.checkAdvancement("F1").violation, false);

  // 更正业务时刻到保护区间内：补出违规
  lib.submitAdvancements([adv({ id: "F1", loanId: "L1", revision: 2, occurredAt: T0 + 5 * DAY })]);
  assert.equal(lib.checkAdvancement("F1").violation, true);

  // 作废推进：不再是有效推进
  lib.submitAdvancements([adv({ id: "F1", loanId: "L1", revision: 3, occurredAt: T0 + 5 * DAY, voided: true })]);
  const v = lib.checkAdvancement("F1");
  assert.equal(v.active, false);
  assert.equal(v.violation, false);
  lib.close();
});

test("只与同一贷款的申请比较；未登记推进返回 inactive", () => {
  const lib = new DualTrackReview(":memory:");
  lib.submitApplications([app({ id: "A1", loanId: "L1", revision: 1 })]);
  lib.submitAdvancements([adv({ id: "F1", loanId: "L2", revision: 1, occurredAt: T0 })]);
  assert.equal(lib.checkAdvancement("F1").violation, false);
  const missing = lib.checkAdvancement("F-unknown");
  assert.equal(missing.active, false);
  assert.equal(missing.violation, false);
  lib.close();
});

test("批量登记与 SQLite 文件持久化", () => {
  const dir = mkdtempSync(join(tmpdir(), "dual-track-"));
  const dbPath = join(dir, "review.db");
  try {
    const lib = new DualTrackReview(dbPath);
    lib.submitApplications([
      app({ id: "A1", loanId: "L1", revision: 1, completeAt: T0, terminatedAt: null }),
      app({ id: "A2", loanId: "L1", revision: 1, completeAt: T0 + DAY, terminatedAt: null }),
    ]);
    lib.submitAdvancements([
      adv({ id: "F1", loanId: "L1", revision: 1, occurredAt: T0 + 2 * DAY }),
      adv({ id: "F2", loanId: "L1", revision: 1, occurredAt: T0 + 2 * DAY }),
    ]);
    lib.close();

    // 重新打开同一文件，判定一致
    const reopened = new DualTrackReview(dbPath);
    assert.equal(reopened.checkAdvancement("F1").violation, true);
    assert.deepEqual(reopened.checkAdvancement("F2").protectedBy, ["A1", "A2"]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
