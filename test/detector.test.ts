import { test } from "node:test";
import assert from "node:assert/strict";
import { SignatureRuleSet } from "../src/index.js";

function detect(
  rules: Array<[string, string]>,
  chunks: Uint8Array[],
): string[] {
  const set = new SignatureRuleSet();
  for (const [id, pattern] of rules) set.addRule({ id, pattern });
  const d = set.createDetection();
  for (const c of chunks) d.push(c);
  return d.end();
}

function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

function text(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

test("literal match anywhere in body", () => {
  assert.deepEqual(detect([["r1", "abc"]], [text("xxabcxx")]), ["r1"]);
  assert.deepEqual(detect([["r1", "abc"]], [text("xxabdxx")]), []);
});

test("escaped metacharacters are literal", () => {
  assert.deepEqual(detect([["r", "a\\.b"]], [text("a.b")]), ["r"]);
  assert.deepEqual(detect([["r", "a\\.b"]], [text("axb")]), []);
  assert.deepEqual(detect([["r", "\\(\\)\\[\\]\\*\\+\\?\\|\\^\\$\\\\"]], [text("()[]*+?|^$\\")]), ["r"]);
});

test("hex byte escapes match binary bytes", () => {
  assert.deepEqual(detect([["r", "\\x00\\xff"]], [bytes(1, 0, 255, 2)]), ["r"]);
  assert.deepEqual(detect([["r", "\\x41\\x42"]], [text("AB")]), ["r"]);
  assert.deepEqual(detect([["r", "\\x00"]], [text("abc")]), []);
});

test("dot matches any byte including newline", () => {
  assert.deepEqual(detect([["r", "a.b"]], [bytes(97, 10, 98)]), ["r"]);
  assert.deepEqual(detect([["r", "a.b"]], [bytes(97, 0, 98)]), ["r"]);
  assert.deepEqual(detect([["r", "a.b"]], [text("ab")]), []);
});

test("character classes, ranges and negation", () => {
  assert.deepEqual(detect([["r", "[abc]+"]], [text("zabz")]), ["r"]);
  assert.deepEqual(detect([["r", "[a-c]+"]], [text("xyz")]), []);
  // Negation is relative to all 256 bytes, including newline and NUL.
  assert.deepEqual(detect([["r", "[^a]"]], [bytes(10)]), ["r"]);
  assert.deepEqual(detect([["r", "[^a]"]], [bytes(0)]), ["r"]);
  assert.deepEqual(detect([["r", "[^a]"]], [text("a")]), []);
  assert.deepEqual(detect([["r", "[^\\x00-\\x7f]"]], [bytes(0x80)]), ["r"]);
  assert.deepEqual(detect([["r", "[^\\x00-\\x7f]"]], [bytes(0x40)]), []);
});

test("alternation, groups and nesting", () => {
  assert.deepEqual(detect([["r", "foo|bar"]], [text("xbarx")]), ["r"]);
  assert.deepEqual(detect([["r", "(ab|cd)+e"]], [text("abcdabe")]), ["r"]);
  assert.deepEqual(detect([["r", "(a(b|c))*d"]], [text("abacd")]), ["r"]);
  assert.deepEqual(detect([["r", "(a(b|c))*d"]], [text("abd")]), ["r"]);
});

test("quantifiers", () => {
  assert.deepEqual(detect([["r", "ab*c"]], [text("ac")]), ["r"]);
  assert.deepEqual(detect([["r", "ab*c"]], [text("abbbc")]), ["r"]);
  assert.deepEqual(detect([["r", "ab+c"]], [text("ac")]), []);
  assert.deepEqual(detect([["r", "ab?c"]], [text("ac")]), ["r"]);
  assert.deepEqual(detect([["r", "ab?c"]], [text("abbc")]), []);
});

test("anchors are absolute body start and end", () => {
  assert.deepEqual(detect([["r", "^abc"]], [text("abcdef")]), ["r"]);
  assert.deepEqual(detect([["r", "^abc"]], [text("xabc")]), []);
  assert.deepEqual(detect([["r", "abc$"]], [text("xxabc")]), ["r"]);
  assert.deepEqual(detect([["r", "abc$"]], [text("abcx")]), []);
  assert.deepEqual(detect([["r", "^abc$"]], [text("abc")]), ["r"]);
  assert.deepEqual(detect([["r", "^abc$"]], [text("abc\n")]), []);
  // ^ does not match after a newline inside the body.
  assert.deepEqual(detect([["r", "^b"]], [text("a\nb")]), []);
});

test("empty pattern, empty branch, empty group are legal", () => {
  assert.deepEqual(detect([["r", ""]], [text("anything")]), ["r"]);
  assert.deepEqual(detect([["r", ""]], [bytes()]), ["r"]);
  assert.deepEqual(detect([["r", "a|"]], [text("zzz")]), ["r"]);
  assert.deepEqual(detect([["r", "()"]], [text("z")]), ["r"]);
  assert.deepEqual(detect([["r", "(a|)b"]], [text("b")]), ["r"]);
});

test("nullable loops use empty-string semantics", () => {
  assert.deepEqual(detect([["r", "(a*)*b"]], [text("b")]), ["r"]);
  assert.deepEqual(detect([["r", "(a?)*b"]], [text("aab")]), ["r"]);
  assert.deepEqual(detect([["r", "()*x"]], [text("x")]), ["r"]);
});

test("empty body gives accurate results", () => {
  assert.deepEqual(detect([["r1", "a*"], ["r2", "a+"], ["r3", "^$"], ["r4", "x"]], [bytes()]), ["r1", "r3"]);
});

test("multiple rules: returns each matched id once", () => {
  const hits = detect(
    [["r1", "abc"], ["r2", "abc"], ["r3", "xyz"], ["r4", "a.c"]],
    [text("--abc--")],
  );
  assert.deepEqual(new Set(hits), new Set(["r1", "r2", "r4"]));
  assert.equal(hits.length, new Set(hits).size);
});

test("detections are independent of each other", () => {
  const set = new SignatureRuleSet();
  set.addRule({ id: "r", pattern: "^secret$" });
  const d1 = set.createDetection();
  const d2 = set.createDetection();
  d1.push(text("secret"));
  d2.push(text("public"));
  assert.deepEqual(d1.end(), ["r"]);
  assert.deepEqual(d2.end(), []);
});

test("duplicate rule id is rejected", () => {
  const set = new SignatureRuleSet();
  set.addRule({ id: "r", pattern: "a" });
  assert.throws(() => set.addRule({ id: "r", pattern: "b" }), /duplicate/);
});

test("invalid patterns are rejected", () => {
  const set = new SignatureRuleSet();
  for (const bad of ["(", ")", "a)", "(a", "[a", "*a", "a**", "\\", "\\q", "\\x1", "[z-a]"]) {
    assert.throws(() => set.addRule({ id: `bad:${bad}`, pattern: bad }), SyntaxError, bad);
  }
});

test("empty body is both absolute start and end", () => {
  assert.deepEqual(detect([["r", "$^"]], [bytes()]), ["r"]);
  assert.deepEqual(detect([["r", "^$"]], [bytes()]), ["r"]);
  assert.deepEqual(detect([["r", "$^"]], [text("a")]), []);
});

test("quantified anchors follow empty-string semantics", () => {
  assert.deepEqual(detect([["r", "(^)*a"]], [text("a")]), ["r"]);
  assert.deepEqual(detect([["r", "(^)*a"]], [text("xa")]), ["r"]);
  assert.deepEqual(detect([["r", "a($)+"]], [text("a")]), ["r"]);
  assert.deepEqual(detect([["r", "a($)+"]], [text("ab")]), []);
  assert.deepEqual(detect([["r", "(^)?x"]], [text("x")]), ["r"]);
});

test("push after end throws", () => {
  const set = new SignatureRuleSet();
  set.addRule({ id: "r", pattern: "a" });
  const d = set.createDetection();
  d.end();
  assert.throws(() => d.push(text("a")));
  assert.throws(() => d.end());
});

test("required scenario: ^a.*b$ with newline inside", () => {
  const body = bytes(97, 10, 10, 98); // "a\n\nb"
  assert.deepEqual(detect([["r", "^a.*b$"]], [body]), ["r"]);
  const withTail = bytes(97, 10, 10, 98, 99); // "a\n\nbc"
  assert.deepEqual(detect([["r", "^a.*b$"]], [withTail]), []);
});

test("chunking never changes the hit set", () => {
  const cases: Array<[string, Uint8Array]> = [
    ["^a.*b$", bytes(97, 10, 10, 98)],
    ["^a.*b$", bytes(97, 10, 10, 98, 99)],
    ["(ab|cd)+e$", text("xabcdabe")],
    ["^\\x00[\\x01-\\x05]*\\xff$", bytes(0, 1, 3, 5, 255)],
    ["a|", text("zzz")],
    ["^$", bytes()],
    ["(a(b|c))*d", text("abacd")],
  ];
  for (const [pattern, body] of cases) {
    const whole = detect([["r", pattern]], [body]);
    // Every split point, byte-by-byte, and empty chunks interleaved as noise.
    const chunkings: Uint8Array[][] = [];
    for (let i = 0; i <= body.length; i++) {
      chunkings.push([body.slice(0, i), body.slice(i)]);
    }
    chunkings.push(Array.from(body, (b) => bytes(b)));
    const noisy: Uint8Array[] = [bytes()];
    for (const b of body) noisy.push(bytes(b), bytes());
    noisy.push(bytes());
    chunkings.push(noisy);
    for (const chunks of chunkings) {
      assert.deepEqual(
        detect([["r", pattern]], chunks),
        whole,
        `pattern ${pattern} chunking ${JSON.stringify(chunks.map((c) => [...c]))}`,
      );
    }
  }
});
