import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../src/index.js';
import type { GraphDef, JsonValue, NodeRecord } from '../src/index.js';

// Two-level join: decision A picks the false branch, so B is skipped.
// D merges A's two branches (level 1); E merges skipped B and active D (level 2).
// E is a descendant of the unchosen path but still receives an active edge via D,
// so it must run; it must also wait for B's edge to be deactivated before running.
const graph: GraphDef = {
  nodes: [
    { id: 'A', type: 'decision' },
    { id: 'B', type: 'work' },
    { id: 'C', type: 'work' },
    { id: 'D', type: 'work' },
    { id: 'E', type: 'work' },
  ],
  edges: [
    { from: 'A', to: 'B', on: true },
    { from: 'A', to: 'C', on: false },
    { from: 'B', to: 'D' },
    { from: 'C', to: 'D' },
    { from: 'B', to: 'E' },
    { from: 'D', to: 'E' },
  ],
};

const handlers = {
  A: async (_input: JsonValue) => false,
  B: async (input: JsonValue) => ['B', input],
  C: async (input: JsonValue) => ['C', input],
  D: async (input: JsonValue) => ['D', input],
  E: async (input: JsonValue) => ['E', input],
};

test('two-level join: unchosen branch descendant still runs via another active edge', async () => {
  const result = await runWorkflow(graph, {
    handlers,
    input: 'root-in',
    timeoutMs: 5000,
  });

  assert.equal(result.status, 'success');

  // Expected values computed serially by the same rules.
  const aOut = await handlers.A('root-in');
  const cOut = await handlers.C({ A: aOut });
  const dOut = await handlers.D({ C: cOut });
  const eOut = await handlers.E({ D: dOut });

  assert.deepEqual(result.output, { A: aOut, C: cOut, D: dOut, E: eOut });

  const byId = new Map<string, NodeRecord>();
  for (const record of result.records) {
    assert.equal(record.scope.length, 0);
    assert.ok(!byId.has(record.nodeId), `duplicate record for ${record.nodeId}`);
    byId.set(record.nodeId, record);
  }
  assert.equal(byId.size, 5);
  assert.equal(byId.get('A')!.status, 'success');
  assert.equal(byId.get('B')!.status, 'skipped');
  assert.equal(byId.get('C')!.status, 'success');
  assert.equal(byId.get('D')!.status, 'success');
  assert.equal(byId.get('E')!.status, 'success');
  assert.ok(!('output' in byId.get('B')!));
});

test('join does not fire early: E runs only after B is resolved as skipped', async () => {
  const events: string[] = [];
  const instrumented = {
    A: async () => {
      events.push('A');
      return false;
    },
    B: async (input: JsonValue) => ['B', input],
    C: async (input: JsonValue) => {
      events.push('C');
      return ['C', input];
    },
    D: async (input: JsonValue) => {
      events.push('D');
      return ['D', input];
    },
    E: async (input: JsonValue) => {
      events.push('E');
      return ['E', input];
    },
  };
  const result = await runWorkflow(graph, {
    handlers: instrumented,
    input: 'root-in',
    timeoutMs: 5000,
  });
  assert.equal(result.status, 'success');
  assert.deepEqual(events, ['A', 'C', 'D', 'E']);
});
