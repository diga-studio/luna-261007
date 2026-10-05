import { test } from "node:test";
import { equal } from "node:assert/strict";
import { evaluate } from "../src/index.js";
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

function snap(...policies: Policy[]): Snapshot {
  return { policies };
}

test("no matching policy defaults to deny", () => {
  equal(
    evaluate(snap(policy({ tags: ["low"] })), {
      minute: 0,
      ip: "1.2.3.4",
      tag: "high",
    }),
    "deny",
  );
});

test("empty snapshot denies everything", () => {
  equal(
    evaluate(snap(), { minute: 500, ip: "10.0.0.1", tag: "low" }),
    "deny",
  );
});

test("window start === end means all day", () => {
  const s = snap(policy({ window: { start: 700, end: 700 } }));
  equal(evaluate(s, { minute: 0, ip: "1.1.1.1", tag: "low" }), "allow");
  equal(evaluate(s, { minute: 1439, ip: "1.1.1.1", tag: "low" }), "allow");
});

test("window is start-inclusive, end-exclusive", () => {
  const s = snap(policy({ window: { start: 600, end: 900 } }));
  equal(evaluate(s, { minute: 599, ip: "1.1.1.1", tag: "low" }), "deny");
  equal(evaluate(s, { minute: 600, ip: "1.1.1.1", tag: "low" }), "allow");
  equal(evaluate(s, { minute: 899, ip: "1.1.1.1", tag: "low" }), "allow");
  equal(evaluate(s, { minute: 900, ip: "1.1.1.1", tag: "low" }), "deny");
});

test("window wraps midnight when start > end", () => {
  const s = snap(policy({ window: { start: 1439, end: 1 } }));
  equal(evaluate(s, { minute: 1438, ip: "1.1.1.1", tag: "low" }), "deny");
  equal(evaluate(s, { minute: 1439, ip: "1.1.1.1", tag: "low" }), "allow");
  equal(evaluate(s, { minute: 0, ip: "1.1.1.1", tag: "low" }), "allow");
  equal(evaluate(s, { minute: 1, ip: "1.1.1.1", tag: "low" }), "deny");
});

test("cidr matching respects prefix and normalizes host bits", () => {
  const s = snap(policy({ cidrs: ["10.0.0.0/8", "192.168.0.0/16"] }));
  equal(evaluate(s, { minute: 0, ip: "10.255.255.255", tag: "low" }), "allow");
  equal(evaluate(s, { minute: 0, ip: "11.0.0.0", tag: "low" }), "deny");
  equal(evaluate(s, { minute: 0, ip: "192.168.7.7", tag: "low" }), "allow");
  equal(evaluate(s, { minute: 0, ip: "192.169.0.0", tag: "low" }), "deny");
});

test("host bits in cidr base are masked off", () => {
  const s = snap(policy({ cidrs: ["10.0.0.1/8"] }));
  equal(evaluate(s, { minute: 0, ip: "10.0.0.0", tag: "low" }), "allow");
});

test("/32 matches exactly one address", () => {
  const s = snap(policy({ cidrs: ["255.255.255.255/32"] }));
  equal(
    evaluate(s, { minute: 0, ip: "255.255.255.255", tag: "low" }),
    "allow",
  );
  equal(
    evaluate(s, { minute: 0, ip: "255.255.255.254", tag: "low" }),
    "deny",
  );
});

test("smaller priority wins over larger", () => {
  const s = snap(
    policy({ priority: 20, action: "allow" }),
    policy({ priority: 10, action: "deny" }),
  );
  equal(evaluate(s, { minute: 0, ip: "1.1.1.1", tag: "low" }), "deny");
});

test("same priority tie-breaks deny > require-approval > allow", () => {
  const s = snap(
    policy({ priority: 10, action: "allow" }),
    policy({ priority: 10, action: "require-approval" }),
    policy({ priority: 10, action: "deny" }),
  );
  equal(evaluate(s, { minute: 0, ip: "1.1.1.1", tag: "low" }), "deny");
  const s2 = snap(
    policy({ priority: 10, action: "allow" }),
    policy({ priority: 10, action: "require-approval" }),
  );
  equal(
    evaluate(s2, { minute: 0, ip: "1.1.1.1", tag: "low" }),
    "require-approval",
  );
});

test("tag must be in the policy tag set", () => {
  const s = snap(policy({ tags: ["medium"] }));
  equal(evaluate(s, { minute: 0, ip: "1.1.1.1", tag: "medium" }), "allow");
  equal(evaluate(s, { minute: 0, ip: "1.1.1.1", tag: "low" }), "deny");
});
