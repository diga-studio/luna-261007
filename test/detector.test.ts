import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RuleSet } from '../src/index';
import { referenceHitSet, referenceMatches } from './reference';

// ---------- helpers ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function text(s: string): Uint8Array {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
}

/** All chunkings exercised for a body: whole, bytewise, empty-padded, random. */
function chunkingsOf(body: Uint8Array, rng: () => number): Uint8Array[][] {
  const whole = [body];
  const bytewise = [...body].map((b) => bytes(b));
  const emptyPadded = [bytes(), body, bytes(), bytes()];
  const random: Uint8Array[] = [];
  let i = 0;
  while (i < body.length) {
    const n = 1 + Math.floor(rng() * 4);
    random.push(body.slice(i, i + n));
    i += n;
  }
  if (rng() < 0.5) random.unshift(bytes());
  return [whole, bytewise, emptyPadded, random];
}

function runInspection(
  rules: ReadonlyArray<{ id: string; pattern: string }>,
  chunks: Uint8Array[],
): Set<string> {
  const rs = new RuleSet();
  for (const r of rules) rs.addRule(r.id, r.pattern);
  const insp = rs.createInspection();
  for (const c of chunks) insp.submit(c);
  return insp.end();
}

function assertCase(
  rules: ReadonlyArray<{ id: string; pattern: string }>,
  body: Uint8Array,
  rng: () => number,
): void {
  const expected = referenceHitSet(rules, body);
  for (const chunks of chunkingsOf(body, rng)) {
    const actual = runInspection(rules, chunks);
    assert.deepEqual(
      actual,
      expected,
      `mismatch for body=${JSON.stringify([...body])} rules=${JSON.stringify(
        rules.map((r) => r.pattern),
      )}`,
    );
  }
}

// ---------- deterministic cases ----------

test('literal, dot, concat, branch, group, class, quantifiers', () => {
  const rng = mulberry32(1);
  const rules = [
    { id: 'lit', pattern: 'abc' },
    { id: 'dot', pattern: 'a.c' },
    { id: 'branch', pattern: 'foo|bar' },
    { id: 'group', pattern: '(ab)(cd|ef)' },
    { id: 'class', pattern: '[a-c]+' },
    { id: 'negclass', pattern: '[^a-c]' },
    { id: 'star', pattern: 'ab*c' },
    { id: 'plus', pattern: 'ab+c' },
    { id: 'quest', pattern: 'ab?c' },
    { id: 'nested', pattern: '((a|b)c)*(d|e(f|g))' },
    { id: 'esc', pattern: 'a\\.b\\|c\\*d' },
  ];
  assertCase(rules, text('abc'), rng);
  assertCase(rules, text('a\nc'), rng); // dot matches newline
  assertCase(rules, text('xxbarxx'), rng);
  assertCase(rules, text('abef'), rng);
  assertCase(rules, text('z'), rng);
  assertCase(rules, text('ac'), rng);
  assertCase(rules, text('abbc'), rng);
  assertCase(rules, text('bcbcfg'), rng);
  assertCase(rules, text('a.b|c*d'), rng);
  assertCase(rules, text('nomatch here'), rng);
});

test('nullable loops, empty pattern, empty branch, empty group, empty body', () => {
  const rng = mulberry32(2);
  const rules = [
    { id: 'nullable-loop', pattern: '(a*)*b' },
    { id: 'nullable-alt', pattern: '(a|)*b' },
    { id: 'empty-pattern', pattern: '' },
    { id: 'empty-branch', pattern: 'a|' },
    { id: 'empty-group', pattern: '()x' },
    { id: 'empty-group-star', pattern: '()*x' },
    { id: 'quest-group', pattern: '(ab)?cd' },
  ];
  assertCase(rules, text('b'), rng);
  assertCase(rules, text('aaab'), rng);
  assertCase(rules, text('x'), rng);
  assertCase(rules, text('cd'), rng);
  assertCase(rules, text('abcd'), rng);
  assertCase(rules, bytes(), rng); // empty body: empty pattern/branch must hit
});

test('binary bytes via \\xHH escapes', () => {
  const rng = mulberry32(3);
  const rules = [
    { id: 'nul', pattern: '\\x00' },
    { id: 'ff', pattern: '\\xff' },
    { id: 'seq', pattern: '\\x00\\x01\\x02' },
    { id: 'range', pattern: '[\\x00-\\x1f]+' },
    { id: 'negrange', pattern: '[^\\x00-\\x7f]' },
    { id: 'dotbin', pattern: 'a.\\xfe' },
  ];
  assertCase(rules, bytes(0x00, 0x01, 0x02), rng);
  assertCase(rules, bytes(0xff), rng);
  assertCase(rules, bytes(0x61, 0x0a, 0xfe), rng);
  assertCase(rules, bytes(0x80, 0x90), rng);
  assertCase(rules, text('plain ascii'), rng);
  assertCase(rules, bytes(), rng);
});

test('absolute anchors ^ and $', () => {
  const rng = mulberry32(4);
  const rules = [
    { id: 'start', pattern: '^abc' },
    { id: 'end', pattern: 'abc$' },
    { id: 'both', pattern: '^abc$' },
    { id: 'empty-anchors', pattern: '^$' },
    { id: 'start-alt', pattern: '^(a|b)c' },
    { id: 'dollar-in-alt', pattern: '(ab$)|c' },
    { id: 'bare-start', pattern: '^' },
    { id: 'bare-end', pattern: '$' },
  ];
  assertCase(rules, text('abc'), rng);
  assertCase(rules, text('xabc'), rng);
  assertCase(rules, text('abcx'), rng);
  assertCase(rules, text('xabcx'), rng);
  assertCase(rules, text('ab'), rng);
  assertCase(rules, text('ab\nc'), rng);
  assertCase(rules, bytes(), rng);
});

test('^a.*b$ required scenario', () => {
  const rng = mulberry32(5);
  const rules = [{ id: 'sig', pattern: '^a.*b$' }];
  // a ... newline bytes ... b  -> hit
  assertCase(rules, text('a\n\nb'), rng);
  assertCase(rules, text('ahello\nworld\nb'), rng);
  assertCase(rules, text('ab'), rng);
  // trailing extra byte -> no hit
  assertCase(rules, text('a\n\nbc'), rng);
  assertCase(rules, text('abc'), rng);
  // missing start / end
  assertCase(rules, text('xa\nb'), rng);
  assertCase(rules, text('a\nb\n'), rng);
  assertCase(rules, bytes(), rng);

  // explicit chunk-boundary check: split right after 'a' and before final 'b'
  const rs = new RuleSet();
  rs.addRule('sig', '^a.*b$');
  const insp = rs.createInspection();
  insp.submit(text('a'));
  insp.submit(text('\n\n'));
  insp.submit(text('b'));
  assert.deepEqual(insp.end(), new Set(['sig']));

  const rs2 = new RuleSet();
  rs2.addRule('sig', '^a.*b$');
  const insp2 = rs2.createInspection();
  insp2.submit(text('a\n\nb'));
  insp2.submit(text('c'));
  assert.deepEqual(insp2.end(), new Set());
});

// ---------- inspection semantics ----------

test('inspections are independent; hits deduplicated; empty chunks are no-ops', () => {
  const rs = new RuleSet();
  rs.addRule('r1', 'foo');
  rs.addRule('r2', 'bar');

  const a = rs.createInspection();
  const b = rs.createInspection();
  a.submit(text('foo'));
  b.submit(text('bar'));
  assert.deepEqual(a.end(), new Set(['r1']));
  assert.deepEqual(b.end(), new Set(['r2']));

  const c = rs.createInspection();
  c.submit(bytes());
  c.submit(text('foofoofoo'));
  c.submit(bytes());
  const hits = c.end();
  assert.deepEqual(hits, new Set(['r1'])); // one entry despite 3 occurrences
  assert.deepEqual(c.end(), hits); // end() is idempotent
  assert.throws(() => c.submit(text('x')), /already ended/);
});

test('duplicate rule id rejected; invalid pattern rejected', () => {
  const rs = new RuleSet();
  rs.addRule('x', 'abc');
  assert.throws(() => rs.addRule('x', 'def'), /duplicate rule id/);
  assert.throws(() => rs.addRule('bad1', '(abc'), /expected '\)'/);
  assert.throws(() => rs.addRule('bad2', 'a**'), /double quantifier/);
  assert.throws(() => rs.addRule('bad3', '[z-a]'), /range/);
  assert.throws(() => rs.addRule('bad4', 'a\\'), /trailing backslash/);
});

// ---------- randomized differential testing vs reference ----------

// The generator only applies '*'/'+' to "simple" atoms (literals, dot,
// classes). Quantified groups can send the V8 reference engine into
// exponential backtracking, which makes the oracle unreliable (on its
// internal backtrack limit it can even bail out with a wrong "no match").
// Quantified-group semantics are covered by deterministic cases above.
interface Gen {
  src: string;
  nullable: boolean;
  simple: boolean;
}

function genPattern(rng: () => number, depth: number): Gen {
  const branchCount = 1 + Math.floor(rng() * 3);
  const branches: Gen[] = [];
  for (let i = 0; i < branchCount; i++) {
    branches.push(genConcat(rng, depth));
  }
  return {
    src: branches.map((b) => b.src).join('|'),
    nullable: branches.some((b) => b.nullable),
    simple: false,
  };
}

function genConcat(rng: () => number, depth: number): Gen {
  const partCount = Math.floor(rng() * 4); // 0..3, may be empty
  let src = '';
  let nullable = true;
  for (let i = 0; i < partCount; i++) {
    const part = genRepeat(rng, depth);
    src += part.src;
    nullable = nullable && part.nullable;
  }
  return { src, nullable, simple: false };
}

function genRepeat(rng: () => number, depth: number): Gen {
  const atom = genAtom(rng, depth);
  if (atom.src === '^' || atom.src === '$') return atom; // never quantify anchors
  const r = rng();
  if (r < 0.25) {
    if (atom.simple) return { src: atom.src + '*', nullable: true, simple: false };
    return { src: atom.src + '?', nullable: true, simple: false };
  }
  if (r < 0.45) {
    if (atom.simple) return { src: atom.src + '+', nullable: false, simple: false };
    return atom;
  }
  if (r < 0.6) {
    return { src: atom.src + '?', nullable: true, simple: false };
  }
  return atom;
}

function genAtom(rng: () => number, depth: number): Gen {
  const r = rng();
  if (r < 0.3) return { src: 'abc'[Math.floor(rng() * 3)], nullable: false, simple: true };
  if (r < 0.38) {
    return {
      src: ['\\x00', '\\x0a', '\\xff', '\\x41'][Math.floor(rng() * 4)],
      nullable: false,
      simple: true,
    };
  }
  if (r < 0.46) return { src: '.', nullable: false, simple: true };
  if (r < 0.52) {
    return { src: ['\\.', '\\|', '\\*', '\\\\'][Math.floor(rng() * 4)], nullable: false, simple: true };
  }
  if (r < 0.66) {
    return {
      src: ['[abc]', '[a-c]', '[^abc]', '[^a-c]', '[\\x00-\\x7f]', '[^\\x00-\\x7f]', '[ab\\x00]'][
        Math.floor(rng() * 7)
      ],
      nullable: false,
      simple: true,
    };
  }
  if (r < 0.72) return { src: '^', nullable: true, simple: false };
  if (r < 0.78) return { src: '$', nullable: true, simple: false };
  if (depth >= 3) return { src: 'abc'[Math.floor(rng() * 3)], nullable: false, simple: true };
  const inner = genPattern(rng, depth + 1);
  return { src: '(' + inner.src + ')', nullable: inner.nullable, simple: false };
}

function genBody(rng: () => number): Uint8Array {
  const len = Math.floor(rng() * 13);
  const body = new Uint8Array(len);
  const alphabet = [0x61, 0x62, 0x63, 0x0a, 0x00, 0xff, 0x2e, 0x7c]; // a b c \n NUL FF . |
  for (let i = 0; i < len; i++) {
    body[i] =
      rng() < 0.8
        ? alphabet[Math.floor(rng() * alphabet.length)]
        : Math.floor(rng() * 256);
  }
  return body;
}

test('random patterns and bodies match reference across chunkings', () => {
  const rng = mulberry32(0xC0FFEE);
  for (let iter = 0; iter < 400; iter++) {
    const ruleCount = 1 + Math.floor(rng() * 4);
    const rules = Array.from({ length: ruleCount }, (_, i) => ({
      id: `r${i}`,
      pattern: genPattern(rng, 0).src,
    }));
    // sanity: patterns must be valid for the reference engine too
    const body = genBody(rng);
    assertCase(rules, body, rng);
  }
});

test('reference oracle itself is sane', () => {
  assert.equal(referenceMatches('^a.*b$', text('a\nb')), true);
  assert.equal(referenceMatches('^a.*b$', text('a\nbc')), false);
  assert.equal(referenceMatches('', bytes()), true);
  assert.equal(referenceMatches('[^a]', bytes(0xff)), true);
});
