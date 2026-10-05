import { test } from "node:test";
import { equal, notEqual, ok } from "node:assert/strict";
import { compare, evaluate } from "../src/index.js";
import type { Policy, Snapshot } from "../src/index.js";

function policy(partial: Partial<Policy>): Policy {
  return {
    priority: 50,
    action: "allow",
    cidrs: ["0.0.0.0/0"],
    window: { start: 0, end: 0 },
    tags: ["low", "medium", "high"],
    ...partial,
  };
}

function assertEvidenceReplays(left: Snapshot, right: Snapshot): void {
  const result = compare(left, right);
  ok(!result.equal, "expected drift to be reported");
  ok(result.evidence.length > 0, "expected at least one evidence request");
  for (const request of result.evidence) {
    notEqual(
      evaluate(left, request),
      evaluate(right, request),
      `evidence must replay to different actions: ${JSON.stringify(request)}`,
    );
  }
}

test("cidr split and duplicate cidrs are equivalent", () => {
  const left: Snapshot = {
    policies: [
      policy({ priority: 20, cidrs: ["10.0.0.0/9"], tags: ["high"] }),
    ],
  };
  const right: Snapshot = {
    policies: [
      policy({
        priority: 20,
        cidrs: ["10.0.0.0/10", "10.64.0.0/10", "10.0.0.0/10"],
        tags: ["high"],
      }),
    ],
  };
  const result = compare(left, right);
  equal(result.equal, true);
  equal(result.evidence.length, 0);
});

test("differences fully shadowed by a higher priority policy are equivalent", () => {
  const shadow = policy({
    priority: 5,
    action: "deny",
    cidrs: ["0.0.0.0/0"],
    window: { start: 0, end: 0 },
    tags: ["low", "medium", "high"],
  });
  const left: Snapshot = {
    policies: [
      shadow,
      policy({ priority: 90, action: "allow", cidrs: ["10.0.0.0/8"] }),
    ],
  };
  const right: Snapshot = {
    policies: [
      shadow,
      policy({
        priority: 91,
        action: "require-approval",
        cidrs: ["172.16.0.0/12"],
        window: { start: 100, end: 200 },
        tags: ["low"],
      }),
    ],
  };
  const result = compare(left, right);
  equal(result.equal, true);
  equal(result.evidence.length, 0);
});

test("removing the shadow exposes the real difference", () => {
  const left: Snapshot = {
    policies: [policy({ priority: 90, action: "allow", cidrs: ["10.0.0.0/8"] })],
  };
  const right: Snapshot = {
    policies: [
      policy({
        priority: 91,
        action: "require-approval",
        cidrs: ["172.16.0.0/12"],
        window: { start: 100, end: 200 },
        tags: ["low"],
      }),
    ],
  };
  assertEvidenceReplays(left, right);
});

test("window and tag differences are detected", () => {
  const left: Snapshot = {
    policies: [policy({ window: { start: 0, end: 720 }, tags: ["low"] })],
  };
  const right: Snapshot = {
    policies: [policy({ window: { start: 720, end: 0 }, tags: ["low"] })],
  };
  assertEvidenceReplays(left, right);
});

test("spec scenario: extra high-priority deny on 255.255.255.255 causes drift", () => {
  const shared = policy({
    priority: 20,
    action: "allow",
    cidrs: ["0.0.0.0/0"],
    window: { start: 0, end: 0 },
    tags: ["high"],
  });
  const left: Snapshot = {
    policies: [
      shared,
      policy({
        priority: 10,
        action: "deny",
        cidrs: ["255.255.255.255/32", "255.255.255.255/32"],
        window: { start: 1439, end: 1 },
        tags: ["low", "medium", "high"],
      }),
    ],
  };
  const right: Snapshot = { policies: [shared] };
  const result = compare(left, right);
  ok(!result.equal);
  ok(result.evidence.length > 0);
  for (const request of result.evidence) {
    equal(evaluate(left, request), "deny");
    equal(evaluate(right, request), "allow");
    equal(request.ip, "255.255.255.255");
    equal(request.tag, "high");
    ok(
      request.minute === 1439 || request.minute === 0,
      `unexpected minute ${request.minute}`,
    );
  }
});

test("identical snapshots are equal", () => {
  const snapshot: Snapshot = {
    policies: [
      policy({ priority: 1, action: "require-approval", tags: ["medium"] }),
      policy({
        priority: 100,
        action: "deny",
        cidrs: ["8.8.8.0/24"],
        window: { start: 1430, end: 10 },
      }),
    ],
  };
  const result = compare(snapshot, snapshot);
  equal(result.equal, true);
  equal(result.evidence.length, 0);
});
