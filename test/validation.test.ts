import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NomadPayKernel, TREASURY } from '../src/index.js';
import type { RateTable } from '../src/index.js';
import { BASE_RATES, HookGate, ManualClock } from './helpers.js';

function rates(overrides: Partial<RateTable> = {}): RateTable {
  return { ...BASE_RATES, ...overrides };
}

function makeKernel(
  clock: ManualClock,
  gate: HookGate,
  initialBalances: Record<string, Partial<Record<string, string>>> = {},
): NomadPayKernel {
  return new NomadPayKernel({ initialBalances, rates: rates(), clock, beforeCommit: gate.hook });
}

test('invalid inputs reject deterministically without touching state', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, { alice: { USDT: '100' } });

  assert.deepEqual(await kernel.transfer('alice', 'alice', 'USDT', '1', 'k1'), {
    status: 'rejected',
    reason: 'SAME_WALLET',
  });
  assert.deepEqual(await kernel.transfer('alice', TREASURY, 'USDT', '1', 'k2'), {
    status: 'rejected',
    reason: 'SAME_WALLET',
  });
  for (const [i, bad] of ['0', '-1', 'abc', '1.123456789', ''].entries()) {
    assert.deepEqual(await kernel.transfer('alice', 'bob', 'USDT', bad, `ka${i}`), {
      status: 'rejected',
      reason: 'INVALID_AMOUNT',
    });
  }
  assert.deepEqual(await kernel.transfer('alice', 'bob', 'DOGE' as never, '1', 'kt'), {
    status: 'rejected',
    reason: 'INVALID_TOKEN',
  });

  assert.equal(gate.calls, 0);
  assert.equal(kernel.inspect('alice').balances.USDT, '100.00000000');
  assert.equal(kernel.inspect('alice').rollingLimitUsedUsdt, '0');
});

test('setRates replaces the table atomically and validates fully first', () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate);

  assert.throws(() =>
    kernel.setRates(rates({ BTC: 'not-a-number' })),
  );
  assert.throws(() =>
    kernel.setRates({ ...rates(), USDT: undefined } as unknown as RateTable),
  );
  assert.throws(() => kernel.setRates(rates({ ETH: '0' })));

  // Failed replacements leave the old table in place; valid ones apply whole.
  kernel.setRates(rates({ BTC: '40000.00000000' }));
  assert.throws(() => kernel.setRates(rates({ BTC: '-5' })));
});

test('rolling limit is per sender across all tokens and recipients', async () => {
  const clock = new ManualClock();
  const gate = new HookGate();
  const kernel = makeKernel(clock, gate, {
    alice: { USDT: '20000', BTC: '1', SOL: '100' },
    dave: { USDT: '100' },
  });

  // 15000 USDT + 0.5 BTC (=10000) = 25000 exactly, via different tokens/recipients.
  const a = await kernel.transfer('alice', 'bob', 'USDT', '15000', 'k1');
  const b = await kernel.transfer('alice', 'carol', 'BTC', '0.5', 'k2');
  assert.equal(a.status, 'success');
  assert.equal(b.status, 'success');
  assert.equal(kernel.inspect('alice').rollingLimitUsedUsdt, '25000');

  // Switching token or recipient does not bypass the limit.
  assert.deepEqual(await kernel.transfer('alice', 'dave', 'SOL', '1', 'k3'), {
    status: 'rejected',
    reason: 'LIMIT_EXCEEDED',
  });
  assert.deepEqual(await kernel.transfer('alice', 'bob', 'USDT', '0.5', 'k4'), {
    status: 'rejected',
    reason: 'LIMIT_EXCEEDED',
  });

  // Other senders have their own independent window.
  const daves = await kernel.transfer('dave', 'bob', 'USDT', '50', 'k5');
  assert.equal(daves.status, 'success');
  assert.equal(kernel.inspect('dave').rollingLimitUsedUsdt, '50');
});
