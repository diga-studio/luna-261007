const test = require("node:test");
const assert = require("node:assert/strict");
const { compare, evaluate } = require("../dist/index.js");

const ALL_TAGS = ["low", "medium", "high"];
const ALL_DAY = { start: 0, end: 0 };

function policy(overrides) {
  return {
    priority: 50,
    action: "allow",
    cidrs: ["0.0.0.0/0"],
    window: ALL_DAY,
    tags: ALL_TAGS,
    ...overrides,
  };
}

function assertEvidenceReplays(left, right, result) {
  assert.equal(result.equivalent, result.evidence.length === 0);
  for (const item of result.evidence) {
    assert.notEqual(item.left, item.right);
    assert.equal(evaluate(left, item.request), item.left);
    assert.equal(evaluate(right, item.request), item.right);
  }
}

test("identical snapshots are equivalent", () => {
  const snapshot = {
    policies: [
      policy({ priority: 10, action: "deny", cidrs: ["10.0.0.0/8"] }),
      policy({ priority: 20, action: "allow", tags: ["high"] }),
    ],
  };
  const result = compare(snapshot, snapshot);
  assert.equal(result.equivalent, true);
  assert.deepEqual(result.evidence, []);
});

test("textually different snapshots can be equivalent (cidr split + duplicates)", () => {
  const left = {
    policies: [
      policy({ priority: 20, action: "allow", cidrs: ["10.0.0.0/8"] }),
      policy({ priority: 30, action: "deny", cidrs: ["10.1.0.0/16"] }),
    ],
  };
  const right = {
    policies: [
      policy({
        priority: 20,
        action: "allow",
        cidrs: ["10.0.0.0/9", "10.128.0.0/9", "10.0.0.0/9"],
      }),
      policy({
        priority: 30,
        action: "deny",
        cidrs: ["10.1.0.0/16", "10.1.0.0/16"],
      }),
    ],
  };
  const result = compare(left, right);
  assert.equal(result.equivalent, true);
  assert.deepEqual(result.evidence, []);
});

test("differences fully shadowed by a higher-priority policy are equivalent", () => {
  const shadow = policy({
    priority: 10,
    action: "deny",
    cidrs: ["0.0.0.0/0"],
  });
  const left = {
    policies: [
      shadow,
      policy({ priority: 90, action: "allow", cidrs: ["10.0.0.0/8"] }),
      policy({ priority: 95, action: "require-approval", tags: ["low"] }),
    ],
  };
  const right = { policies: [shadow] };
  const result = compare(left, right);
  assert.equal(result.equivalent, true);
  assert.deepEqual(result.evidence, []);
});

test("removing the shadow exposes the real differences", () => {
  const left = {
    policies: [
      policy({ priority: 90, action: "allow", cidrs: ["10.0.0.0/8"] }),
      policy({
        priority: 95,
        action: "require-approval",
        cidrs: ["10.0.0.0/8"],
        tags: ["low"],
      }),
    ],
  };
  const right = { policies: [] };
  const result = compare(left, right);
  assert.equal(result.equivalent, false);
  assert.ok(result.evidence.length > 0);
  assertEvidenceReplays(left, right, result);
  const ips = new Set(result.evidence.map((e) => e.request.ip));
  assert.ok([...ips].every((ip) => ip.startsWith("10.")));
});

test("cross-midnight deny on a single address drifts from baseline allow", () => {
  const baseline = policy({
    priority: 20,
    action: "allow",
    cidrs: ["0.0.0.0/0"],
    window: { start: 0, end: 0 },
    tags: ["high"],
  });
  const left = {
    policies: [
      baseline,
      policy({
        priority: 10,
        action: "deny",
        cidrs: ["255.255.255.255/32", "255.255.255.255/32"],
        window: { start: 1439, end: 1 },
        tags: ALL_TAGS,
      }),
    ],
  };
  const right = { policies: [baseline] };
  const result = compare(left, right);
  assert.equal(result.equivalent, false);
  assert.ok(result.evidence.length > 0);
  assertEvidenceReplays(left, right, result);
  for (const item of result.evidence) {
    assert.equal(item.request.ip, "255.255.255.255");
    assert.equal(item.request.tag, "high");
    assert.ok(item.request.minute === 1439 || item.request.minute === 0);
    assert.equal(item.left, "deny");
    assert.equal(item.right, "allow");
  }
});

test("window boundary difference is detected", () => {
  const left = {
    policies: [policy({ window: { start: 0, end: 720 } })],
  };
  const right = {
    policies: [policy({ window: { start: 0, end: 721 } })],
  };
  const result = compare(left, right);
  assert.equal(result.equivalent, false);
  assertEvidenceReplays(left, right, result);
  assert.ok(
    result.evidence.every((e) => e.request.minute === 720),
    "drift isolated to minute 720",
  );
});
