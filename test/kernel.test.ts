import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NomadPayKernel, TREASURY } from '../src/index.js';
import type { RateTable, TransferResult } from '../src/index.js';
import { BASE_RATES, DAY_MS, HookGate, ManualClock } from './helpers.js';

function rates(overrides: Partial<RateTable> = {}): RateTable {
  return { ...BASE_RATES, ...overrides };
}

function makeKernel(
  clock: ManualClock,
  gate: HookGate,
  initialBalances: Record<string, Partial<Record<string, string>>> = {},
  rateOverrides: Partial<RateTable> = {},
): NomadPayKernel {
  return new NomadPayKernel({
    initialBalances,
    rates: rates(rateOverrides),
    clock,
    beforeCommit: gate.hook,
  });
}

test('successful transfer moves principal and fee atomically and occupies quota', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { USDT: '1000' } });

  const result = await kernel.transfer('alice', 'bob', 'USDT', '100', 'k1');
  assert.deepEqual(result, {
    status: 'success',
    token: 'USDT',
    amount: '100.00000000',
    fee: '0.10000000',
    valuationUsdt: '100',
    committedAt: clock.now(),
  });
  assert.equal(gate.calls, 1);

  const alice = kernel.inspect('alice');
  assert.equal(alice.balances.USDT, '899.90000000');
  assert.equal(alice.rollingLimitUsedUsdt, '100');
  assert.equal(kernel.inspect('bob').balances.USDT, '100.00000000');
  assert.equal(kernel.inspect(TREASURY).balances.USDT, '0.10000000');
  assert.equal(kernel.inspect(TREASURY).rollingLimitUsedUsdt, '0');
});

test('initial balances do not occupy sending quota', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { BTC: '100' } });
  assert.equal(kernel.inspect('alice').rollingLimitUsedUsdt, '0');
});

test('insufficient funds rejects without touching state or calling the hook', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { USDT: '10' } });

  const result = await kernel.transfer('alice', 'bob', 'USDT', '10', 'k1'); // 10 + fee > 10
  assert.deepEqual(result, { status: 'rejected', reason: 'INSUFFICIENT_FUNDS' });
  assert.equal(gate.calls, 0);
  assert.equal(kernel.inspect('alice').balances.USDT, '10.00000000');
  assert.equal(kernel.inspect('bob').balances.USDT, '0.00000000');
  assert.equal(kernel.inspect(TREASURY).balances.USDT, '0.00000000');
});

test('rolling limit: fee does not occupy quota, exact 25000 passes, next wei fails', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { USDT: '30000' } });

  const big = await kernel.transfer('alice', 'bob', 'USDT', '25000', 'k1');
  assert.equal(big.status, 'success'); // valuation exactly 25000, fee 25 not counted
  assert.equal(kernel.inspect('alice').rollingLimitUsedUsdt, '25000');

  const over = await kernel.transfer('alice', 'bob', 'USDT', '0.00000001', 'k2');
  assert.deepEqual(over, { status: 'rejected', reason: 'LIMIT_EXCEEDED' });
  assert.equal(gate.calls, 1); // precheck failed, hook not reached
});

test('rolling window boundary: exactly 24h old transfers stop occupying quota', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { USDT: '100000' } });

  await kernel.transfer('alice', 'bob', 'USDT', '20000', 'k1');
  const t0 = clock.now();

  clock.set(t0 + DAY_MS - 1);
  assert.equal(kernel.inspect('alice').rollingLimitUsedUsdt, '20000');
  const stillBlocked = await kernel.transfer('alice', 'bob', 'USDT', '5000.00000001', 'k2');
  assert.deepEqual(stillBlocked, { status: 'rejected', reason: 'LIMIT_EXCEEDED' });

  clock.set(t0 + DAY_MS);
  assert.equal(kernel.inspect('alice').rollingLimitUsedUsdt, '0');
  const nowFree = await kernel.transfer('alice', 'bob', 'USDT', '25000', 'k3');
  assert.equal(nowFree.status, 'success');
});
