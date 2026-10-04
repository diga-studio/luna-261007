import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../src/index.js';
import type { GraphDef, JsonObject, JsonValue, NodeRecord } from '../src/index.js';

// Outer: W produces an array, L loops over it.
// Body: decision R picks branch P (odd) or Q (even); S merges them.
// T is a second body root that echoes its element, making per-iteration
// data isolation directly observable.
const graph: GraphDef = {
  nodes: [
    { id: 'W', type: 'work' },
    {
      id: 'L',
      type: 'loop',
      body: {
        nodes: [
          { id: 'R', type: 'decision' },
          { id: 'T', type: 'work' },
          { id: 'P', type: 'work' },
          { id: 'Q', type: 'work' },
          { id: 'S', type: 'work' },
        ],
        edges: [
          { from: 'R', to: 'P', on: true },
          { from: 'R', to: 'Q', on: false },
          { from: 'P', to: 'S' },
          { from: 'Q', to: 'S' },
        ],
      },
    },
  ],
  edges: [{ from: 'W', to: 'L' }],
};

const elements = [{ n: 1 }, { n: 2 }, { n: 3 }];

const handlers = {
  W: async (_input: JsonValue) => elements,
  R: async (el: JsonValue) => (el as { n: number }).n % 2 === 1,
  T: async (el: JsonValue) => ['T', el],
  P: async (input: JsonValue) => ['P', input],
  Q: async (input: JsonValue) => ['Q', input],
  S: async (input: JsonValue) => ['S', input],
};

function scopeKey(record: NodeRecord): string {
  return `${record.nodeId}@${JSON.stringify(record.scope)}`;
}

test('loop iterations pick different branches, stay isolated, keep input order', async () => {
  const result = await runWorkflow(graph, {
    handlers,
    input: 'run-in',
    timeoutMs: 5000,
  });

  assert.equal(result.status, 'success');

  // Expected iteration results computed serially by the same rules.
  const expectedIterations: JsonObject[] = [];
  for (const el of elements) {
    const rOut = await handlers.R(el);
    const tOut = await handlers.T(el);
    const branchOut = rOut
      ? await handlers.P({ R: rOut })
      : await handlers.Q({ R: rOut });
    const sOut = await handlers.S(rOut ? { P: branchOut } : { Q: branchOut });
    expectedIterations.push(
      rOut
        ? { R: rOut, T: tOut, P: branchOut, S: sOut }
        : { R: rOut, T: tOut, Q: branchOut, S: sOut },
    );
  }

  assert.deepEqual(result.output.W, elements);
  assert.deepEqual(result.output.L, expectedIterations);

  // Skipped nodes occupy no slot in iteration results.
  const iterations = result.output.L as JsonObject[];
  assert.equal(iterations.length, 3);
  assert.ok('P' in iterations[0]! && !('Q' in iterations[0]!));
  assert.ok('Q' in iterations[1]! && !('P' in iterations[1]!));
  assert.ok('P' in iterations[2]! && !('Q' in iterations[2]!));

  // Records: outer nodes have empty scope; body nodes are recorded per
  // iteration and never overwrite each other.
  const seen = new Set<string>();
  for (const record of result.records) {
    const key = scopeKey(record);
    assert.ok(!seen.has(key), `duplicate record ${key}`);
    seen.add(key);
  }
  assert.equal(result.records.length, 2 + 3 * 5);

  const outer = result.records.filter((r) => r.scope.length === 0);
  assert.deepEqual(
    outer.map((r) => r.nodeId).sort(),
    ['L', 'W'],
  );
  assert.equal(outer.find((r) => r.nodeId === 'L')!.status, 'success');

  for (let i = 0; i < 3; i += 1) {
    const iterRecords = result.records.filter(
      (r) => r.scope.length === 1 && r.scope[0]!.loopId === 'L' && r.scope[0]!.iteration === i,
    );
    assert.equal(iterRecords.length, 5);
    const statusOf = (id: string) => iterRecords.find((r) => r.nodeId === id)!.status;
    assert.equal(statusOf('R'), 'success');
    assert.equal(statusOf('T'), 'success');
    assert.equal(statusOf('S'), 'success');
    const odd = elements[i]!.n % 2 === 1;
    assert.equal(statusOf('P'), odd ? 'success' : 'skipped');
    assert.equal(statusOf('Q'), odd ? 'skipped' : 'success');
  }
});

test('empty array: loop succeeds immediately with empty output', async () => {
  const result = await runWorkflow(graph, {
    handlers: { ...handlers, W: async () => [] },
    input: 'run-in',
    timeoutMs: 5000,
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.output.L, []);
  const bodyRecords = result.records.filter((r) => r.scope.length > 0);
  assert.equal(bodyRecords.length, 0);
});
