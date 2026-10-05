const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate } = require("../dist/index.js");

const ALL_TAGS = ["low", "medium", "high"];
const ALL_DAY = { start: 0, end: 0 };
const ALL_IPS = ["0.0.0.0/0"];

function policy(overrides) {
  return {
    priority: 50,
    action: "allow",
    cidrs: ALL_IPS,
    window: ALL_DAY,
    tags: ALL_TAGS,
    ...overrides,
  };
}

test("returns deny when no policy matches", () => {
  const snapshot = { policies: [policy({ tags: ["high"] })] };
  assert.equal(
    evaluate(snapshot, { minute: 100, ip: "1.2.3.4", tag: "low" }),
    "deny",
  );
});

test("empty snapshot denies everything", () => {
  assert.equal(
    evaluate({ policies: [] }, { minute: 0, ip: "0.0.0.0", tag: "low" }),
    "deny",
  );
});

test("all-day window (start === end) matches every minute", () => {
  const snapshot = { policies: [policy({ window: { start: 720, end: 720 } })] };
  for (const minute of [0, 719, 720, 1439]) {
    assert.equal(
      evaluate(snapshot, { minute, ip: "1.2.3.4", tag: "low" }),
      "allow",
    );
  }
});

test("same-day window is start-inclusive and end-exclusive", () => {
  const snapshot = { policies: [policy({ window: { start: 60, end: 120 } })] };
  const at = (minute) =>
    evaluate(snapshot, { minute, ip: "1.2.3.4", tag: "low" });
  assert.equal(at(59), "deny");
  assert.equal(at(60), "allow");
  assert.equal(at(119), "allow");
  assert.equal(at(120), "deny");
});

test("cross-midnight window (start > end) wraps around", () => {
  const snapshot = { policies: [policy({ window: { start: 1439, end: 1 } })] };
  const at = (minute) =>
    evaluate(snapshot, { minute, ip: "1.2.3.4", tag: "low" });
  assert.equal(at(1438), "deny");
  assert.equal(at(1439), "allow");
  assert.equal(at(0), "allow");
  assert.equal(at(1), "deny");
  assert.equal(at(720), "deny");
});

test("cidr membership uses network range", () => {
  const snapshot = { policies: [policy({ cidrs: ["10.0.0.0/8"] })] };
  const forIp = (ip) => evaluate(snapshot, { minute: 0, ip, tag: "low" });
  assert.equal(forIp("10.0.0.0"), "allow");
  assert.equal(forIp("10.255.255.255"), "allow");
  assert.equal(forIp("11.0.0.0"), "deny");
  assert.equal(forIp("9.255.255.255"), "deny");
});

test("any matching cidr is enough, duplicates are harmless", () => {
  const snapshot = {
    policies: [
      policy({ cidrs: ["192.168.0.0/16", "10.0.0.0/8", "10.0.0.0/8"] }),
    ],
  };
  assert.equal(
    evaluate(snapshot, { minute: 0, ip: "10.1.2.3", tag: "low" }),
    "allow",
  );
  assert.equal(
    evaluate(snapshot, { minute: 0, ip: "192.168.0.1", tag: "low" }),
    "allow",
  );
  assert.equal(
    evaluate(snapshot, { minute: 0, ip: "172.16.0.1", tag: "low" }),
    "deny",
  );
});

test("lowest priority number wins", () => {
  const snapshot = {
    policies: [
      policy({ priority: 30, action: "allow" }),
      policy({ priority: 10, action: "deny" }),
      policy({ priority: 20, action: "require-approval" }),
    ],
  };
  assert.equal(
    evaluate(snapshot, { minute: 0, ip: "1.2.3.4", tag: "low" }),
    "deny",
  );
});

test("ties break as deny, then require-approval, then allow", () => {
  const base = { minute: 0, ip: "1.2.3.4", tag: "low" };
  const snapshot = {
    policies: [
      policy({ priority: 10, action: "allow" }),
      policy({ priority: 10, action: "require-approval" }),
      policy({ priority: 10, action: "deny" }),
    ],
  };
  assert.equal(evaluate(snapshot, base), "deny");
  snapshot.policies = snapshot.policies.filter((p) => p.action !== "deny");
  assert.equal(evaluate(snapshot, base), "require-approval");
  snapshot.policies = snapshot.policies.filter(
    (p) => p.action !== "require-approval",
  );
  assert.equal(evaluate(snapshot, base), "allow");
});

test("only matching policies compete", () => {
  const snapshot = {
    policies: [
      policy({ priority: 1, action: "deny", tags: ["high"] }),
      policy({ priority: 50, action: "allow", tags: ["low"] }),
    ],
  };
  assert.equal(
    evaluate(snapshot, { minute: 0, ip: "1.2.3.4", tag: "low" }),
    "allow",
  );
});
