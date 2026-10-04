import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from '../src/index.js';
import type { GraphDef, JsonValue } from '../src/index.js';

const chain: GraphDef = {
  nodes: [
    { id: 'A', type: 'work' },
    { id: 'B', type: 'work' },
    { id: 'C', type: 'work' },
  ],
  edges: [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'C' },
  ],
};

const parallel: GraphDef = {
  nodes: [
    { id: 'A', type: 'work' },
    { id: 'SLOW', type: 'work' },
    { id: 'FAIL', type: 'work' },
    { id: 'D', type: 'work' },
  ],
  edges: [
    { from: 'A', to: 'SLOW' },
    { from: 'A', to: 'FAIL' },
    { from: 'SLOW', to: 'D' },
  ],
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('first handler failure ends the run; pending instances cancelled, none started after', async () => {
  const calls: string[] = [];
  const result = await runWorkflow(chain, {
    handlers: {
      A: async () => {
        calls.push('A');
        return 1;
      },
      B: async () => {
        calls.push('B');
        throw new Error('boom');
      },
      C: async (input: JsonValue) => {
        calls.push('C');
        return input;
      },
    },
    input: null,
    timeoutMs: 5000,
  });

  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, ['A', 'B']); // C never started
  const statusOf = (id: string) =>
    result.records.find((r) => r.nodeId === id)!.status;
  assert.equal(statusOf('A'), 'success');
  assert.equal(statusOf('B'), 'failed');
  assert.equal(statusOf('C'), 'cancelled');
  assert.deepEqual(result.output, { A: 1 });
});

test('late success after failure does not change records or trigger successors', async () => {
  let resolveSlow!: (value: JsonValue) => void;
  const slow = new Promise<JsonValue>((resolve) => {
    resolveSlow = resolve;
  });
  const calls: string[] = [];
  const resultPromise = runWorkflow(parallel, {
    handlers: {
      A: async () => 1,
      SLOW: () => slow,
      FAIL: async () => {
        throw new Error('boom');
      },
      D: async (input: JsonValue) => {
        calls.push('D');
        return input;
      },
    },
    input: null,
    timeoutMs: 5000,
  });

  const result = await resultPromise;
  assert.equal(result.status, 'failed');
  const statusOf = (id: string) =>
    result.records.find((r) => r.nodeId === id)!.status;
  assert.equal(statusOf('SLOW'), 'cancelled');
  assert.equal(statusOf('D'), 'cancelled');

  // The slow handler resolves after the run already ended.
  resolveSlow(42);
  await sleep(10);
  assert.deepEqual(calls, []); // D still never started
  assert.equal(result.records.length, 4); // records unchanged
});

test('timeout ends the run; unfinished instances cancelled; late rejection is swallowed', async () => {
  const result = await runWorkflow(chain, {
    handlers: {
      A: async () => {
        await sleep(50);
        return 1;
      },
      B: async () => {
        await sleep(50);
        throw new Error('late boom');
      },
      C: async (input: JsonValue) => input,
    },
    input: null,
    timeoutMs: 20,
  });

  assert.equal(result.status, 'timeout');
  const statusOf = (id: string) =>
    result.records.find((r) => r.nodeId === id)!.status;
  assert.equal(statusOf('A'), 'cancelled');
  assert.equal(statusOf('B'), 'cancelled');
  assert.equal(statusOf('C'), 'cancelled');
  assert.deepEqual(result.output, {});

  // Let the late handlers settle; nothing may change and nothing may throw.
  await sleep(120);
  assert.equal(result.records.length, 3);
});

test('timeout covers loop iterations', async () => {
  const loopGraph: GraphDef = {
    nodes: [
      {
        id: 'L',
        type: 'loop',
        body: {
          nodes: [{ id: 'S', type: 'work' }],
          edges: [],
        },
      },
    ],
    edges: [],
  };
  const result = await runWorkflow(loopGraph, {
    handlers: {
      S: async (el: JsonValue) => {
        await sleep(50);
        return el;
      },
    },
    input: [1, 2, 3],
    timeoutMs: 20,
  });
  assert.equal(result.status, 'timeout');
  const iterRecords = result.records.filter((r) => r.nodeId === 'S');
  assert.equal(iterRecords.length, 3);
  for (const record of iterRecords) {
    assert.equal(record.status, 'cancelled');
  }
  assert.equal(
    result.records.find((r) => r.nodeId === 'L')!.status,
    'cancelled',
  );
});
