import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NomadPayKernel, TREASURY } from '../src/index.js';
import type { RateTable, TransferResult, TransferSuccess } from '../src/index.js';
import { BASE_RATES, DAY_MS, HookGate, ManualClock } from './helpers.js';

function rates(overrides: Partial<RateTable> = {}): RateTable {
  return { ...BASE_RATES, ...overrides };
}

test('paused commit re-judges with new rates and clock at the exact expiry boundary', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = new NomadPayKernel({
    initialBalances: { alice: { BTC: '10' } },
    rates: rates(), // BTC = 20000 USDT
    clock,
    beforeCommit: gate.hook,
  });

  // First transfer commits immediately: 1 BTC valued at 20000 USDT.
  const first = (await kernel.transfer('alice', 'bob', 'BTC', '1', 'k1')) as TransferSuccess;
  assert.equal(first.status, 'success');
  assert.equal(first.valuationUsdt, '20000');
  const t0 = first.committedAt;

  // Second transfer passes the pre-check, then pauses inside beforeCommit.
  gate.pause();
  const pending = kernel.transfer('alice', 'carol', 'BTC', '0.2', 'k2');
  await new Promise<void>((resolve) => setImmediate(resolve)); // let it reach the hook
  assert.equal(gate.calls, 2);

  // While paused: replace the whole rate table and advance the clock to the
  // exact moment the first transfer leaves the rolling window.
  kernel.setRates(rates({ BTC: '30000.00000000' }));
  clock.set(t0 + DAY_MS);

  gate.release();
  const second = (await pending) as TransferSuccess;

  // The commit uses the NEW rate: 0.2 BTC * 30000 = 6000 USDT exactly.
  assert.equal(second.status, 'success');
  assert.equal(second.valuationUsdt, '6000');
  assert.equal(second.committedAt, t0 + DAY_MS);

  // The first transfer is exactly 24h old: no longer in the window.
  // Had it still counted (20000 under its fixed valuation), the commit would
  // have exceeded the limit; had the second been valued at the pre-pause
  // rate, usage would read 4000 instead of 6000.
  assert.equal(kernel.inspect('alice').rollingLimitUsedUsdt, '6000');

  // Historical valuation stays fixed at 20000 USDT forever.
  assert.equal(first.valuationUsdt, '20000');
  const firstAgain = (await kernel.transfer('alice', 'bob', 'BTC', '1', 'k1')) as TransferSuccess;
  assert.equal(firstAgain.valuationUsdt, '20000');

  // Funds moved exactly once per transfer, with fees under the new commit.
  const alice = kernel.inspect('alice');
  assert.equal(alice.balances.BTC, '8.79880000'); // 10 - 1.001 - 0.2002
  assert.equal(kernel.inspect('bob').balances.BTC, '1.00000000');
  assert.equal(kernel.inspect('carol').balances.BTC, '0.20000000');
  assert.equal(kernel.inspect(TREASURY).balances.BTC, '0.00120000');
});

test('paused commit can flip to rejection when funds vanish during the pause', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = new NomadPayKernel({
    initialBalances: { alice: { USDT: '200' } },
    rates: rates(),
    clock,
    beforeCommit: gate.hook,
  });

  // k1 passes the pre-check, then pauses inside beforeCommit.
  gate.pauseNext(1);
  const pending = kernel.transfer('alice', 'bob', 'USDT', '100', 'k1');
  await new Promise<void>((resolve) => setImmediate(resolve)); // let it reach the hook
  assert.equal(gate.calls, 1);

  // Drain alice while k1 is paused: the pre-check is no authorization.
  const drain = await kernel.transfer('alice', 'carol', 'USDT', '150', 'k2');
  assert.equal(drain.status, 'success');

  gate.release();
  const result = await pending;
  assert.deepEqual(result, { status: 'rejected', reason: 'INSUFFICIENT_FUNDS' });
  assert.equal(kernel.inspect('alice').balances.USDT, '49.85000000');
  assert.equal(kernel.inspect('bob').balances.USDT, '0.00000000');
  assert.equal(kernel.inspect(TREASURY).balances.USDT, '0.15000000');
});
