import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NomadPayKernel, TREASURY } from '../src/index.js';
import type { RateTable, TransferSuccess } from '../src/index.js';
import { BASE_RATES, DAY_MS, HookGate, ManualClock } from './helpers.js';

function rates(overrides: Partial<RateTable> = {}): RateTable {
  return { ...BASE_RATES, ...overrides };
}

function makeKernel(
  clock: ManualClock,
  gate: HookGate,
  initialBalances: Record<string, Partial<Record<string, string>>>,
): NomadPayKernel {
  return new NomadPayKernel({
    initialBalances,
    rates: rates(),
    clock,
    beforeCommit: gate.hook,
  });
}

test('same-key retry after success returns the first result with no extra effect', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { USDT: '100' } });

  const first = await kernel.transfer('alice', 'bob', 'USDT', '10', 'k1');
  assert.equal(first.status, 'success');

  // Change the world: rates, window, balances all move on.
  kernel.setRates(rates({ USDT: '2.00000000' }));
  clock.advance(DAY_MS * 7);
  await kernel.transfer('alice', 'carol', 'USDT', '5', 'other');

  const retry = await kernel.transfer('alice', 'bob', 'USDT', '10', 'k1');
  assert.deepEqual(retry, first); // original valuation and timestamp preserved
  assert.equal(gate.calls, 2); // no extra hook call for the retry
  assert.equal(kernel.inspect('alice').balances.USDT, '84.98500000'); // 100 - 10.01 - 5.005
  assert.equal(kernel.inspect('bob').balances.USDT, '10.00000000');
  assert.equal(kernel.inspect(TREASURY).balances.USDT, '0.01500000');
});

test('concurrent same-key retries share one commit and one financial effect', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { USDT: '100' } });

  gate.pause();
  const a = kernel.transfer('alice', 'bob', 'USDT', '10', 'k1');
  const b = kernel.transfer('alice', 'bob', 'USDT', '10', 'k1');
  const c = kernel.transfer('alice', 'bob', 'USDT', '10.00000000', 'k1'); // canonical-equal
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gate.calls, 1);
  gate.release();

  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(ra.status, 'success');
  assert.deepEqual(rb, ra);
  assert.deepEqual(rc, ra);
  assert.equal(gate.calls, 1);
  assert.equal(kernel.inspect('alice').balances.USDT, '89.99000000'); // charged once
  assert.equal(kernel.inspect('bob').balances.USDT, '10.00000000');
  assert.equal(kernel.inspect(TREASURY).balances.USDT, '0.01000000');
});

test('same key with a different payload conflicts, per-sender keys are isolated', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, {
    alice: { USDT: '100', BTC: '1' },
    dave: { USDT: '100' },
  });

  await kernel.transfer('alice', 'bob', 'USDT', '10', 'k1');

  assert.deepEqual(await kernel.transfer('alice', 'bob', 'USDT', '11', 'k1'), {
    status: 'rejected',
    reason: 'KEY_CONFLICT',
  });
  assert.deepEqual(await kernel.transfer('alice', 'carol', 'USDT', '10', 'k1'), {
    status: 'rejected',
    reason: 'KEY_CONFLICT',
  });
  assert.deepEqual(await kernel.transfer('alice', 'bob', 'BTC', '10', 'k1'), {
    status: 'rejected',
    reason: 'KEY_CONFLICT',
  });

  // The same key under a different sender is an independent key.
  const daves = await kernel.transfer('dave', 'bob', 'USDT', '10', 'k1');
  assert.equal(daves.status, 'success');
});

test('rejection results are memoized and replayed after state changes', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { USDT: '10' }, dave: { USDT: '100' } });

  const first = await kernel.transfer('alice', 'bob', 'USDT', '10', 'k1');
  assert.deepEqual(first, { status: 'rejected', reason: 'INSUFFICIENT_FUNDS' });
  assert.equal(gate.calls, 0);

  // Alice gets funded afterwards; the recorded rejection must not change.
  await kernel.transfer('dave', 'alice', 'USDT', '50', 'fund');
  kernel.setRates(rates({ USDT: '0.50000000' }));
  clock.advance(DAY_MS);

  const retry = await kernel.transfer('alice', 'bob', 'USDT', '10', 'k1');
  assert.deepEqual(retry, first);
  assert.equal(gate.calls, 1); // only the funding transfer ran the hook
  assert.equal(kernel.inspect('alice').balances.USDT, '60.00000000');
  assert.equal(kernel.inspect('bob').balances.USDT, '0.00000000');
});

test('success result and historical valuation survive later rate changes', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { BTC: '3' } });

  const first = (await kernel.transfer('alice', 'bob', 'BTC', '1', 'k1')) as TransferSuccess;
  assert.equal(first.valuationUsdt, '20000');

  kernel.setRates(rates({ BTC: '0.00000001' })); // BTC nearly worthless now
  assert.equal(kernel.inspect('alice').rollingLimitUsedUsdt, '20000'); // not revalued

  const retry = (await kernel.transfer('alice', 'bob', 'BTC', '1', 'k1')) as TransferSuccess;
  assert.deepEqual(retry, first);

  // New transfers use the new rate; the old record keeps its valuation.
  const second = (await kernel.transfer('alice', 'bob', 'BTC', '1', 'k2')) as TransferSuccess;
  assert.equal(second.valuationUsdt, '0.00000001');
  assert.equal(kernel.inspect('alice').rollingLimitUsedUsdt, '20000.00000001');
});
