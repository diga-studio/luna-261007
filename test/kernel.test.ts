import assert from 'node:assert/strict';
import test from 'node:test';

import { NomadPayKernel, TREASURY } from '../src/kernel';
import type { Rates, Token, TransferSuccess } from '../src/types';
import { BASE_RATES, DAY_MS, FakeClock, GateHook, HOUR_MS, tick } from './helpers';

function makeKernel(overrides: {
  clock?: FakeClock;
  balances?: Record<string, Partial<Record<Token, string>>>;
  rates?: Rates;
}): { kernel: NomadPayKernel; clock: FakeClock; gate: GateHook } {
  const clock = overrides.clock ?? new FakeClock();
  const gate = new GateHook();
  const kernel = new NomadPayKernel({
    initialBalances: overrides.balances ?? {
      alice: { BTC: '10.00000000', USDT: '50000.00000000' },
      bob: { USDT: '100.00000000' },
      carol: {},
    },
    rates: overrides.rates ?? BASE_RATES,
    clock,
    beforeCommit: gate.hook,
  });
  return { kernel, clock, gate };
}

async function commitTransfer(
  kernel: NomadPayKernel,
  gate: GateHook,
  sender: string,
  recipient: string,
  token: Token,
  amount: string,
  key: string,
) {
  const pending = kernel.transfer(sender, recipient, token, amount, key);
  await tick();
  assert.equal(gate.paused, true, 'transfer should pause in beforeCommit');
  gate.release();
  return pending;
}

test('successful transfer moves principal and fee atomically', async () => {
  const { kernel, gate } = makeKernel({});
  const result = (await commitTransfer(
    kernel, gate, 'alice', 'bob', 'BTC', '1.00000000', 'k1',
  )) as TransferSuccess;

  assert.equal(result.status, 'success');
  assert.equal(result.amount, '1.00000000');
  assert.equal(result.fee, '0.00100000'); // 0.1% of 1 BTC
  assert.equal(result.valuation, '20000.0000000000000000');

  assert.equal(kernel.inspect('alice').balances.BTC, '8.99900000');
  assert.equal(kernel.inspect('bob').balances.BTC, '1.00000000');
  assert.equal(kernel.inspect(TREASURY).balances.BTC, '0.00100000');
  assert.equal(kernel.inspect('alice').windowUsed, '20000.0000000000000000');
});

test('fee is 0.1% rounded up to 1e-8 with a 0.00010000 floor', async () => {
  const { kernel, gate } = makeKernel({});
  // Tiny amount: proportional fee below the floor.
  const small = (await commitTransfer(
    kernel, gate, 'alice', 'bob', 'USDT', '0.00010001', 'f1',
  )) as TransferSuccess;
  assert.equal(small.fee, '0.00010000');
  // 0.10000001 * 0.001 = 0.00010000001 -> ceil to 0.00010001, above the floor.
  const exact = (await commitTransfer(
    kernel, gate, 'alice', 'bob', 'USDT', '0.10000001', 'f2',
  )) as TransferSuccess;
  assert.equal(exact.fee, '0.00010001');
  // Clean 0.1% with no rounding residue.
  const clean = (await commitTransfer(
    kernel, gate, 'alice', 'bob', 'USDT', '2.50000000', 'f3',
  )) as TransferSuccess;
  assert.equal(clean.fee, '0.00250000');
});

test('initial balances do not consume the sending quota', async () => {
  const { kernel, gate } = makeKernel({});
  assert.equal(kernel.inspect('alice').windowUsed, '0.0000000000000000');
  // 1.25 BTC at 20000 = exactly 25000 USDT: allowed ("must not exceed").
  const ok = await commitTransfer(kernel, gate, 'alice', 'bob', 'BTC', '1.25000000', 'q1');
  assert.equal(ok.status, 'success');
  assert.equal(kernel.inspect('alice').windowUsed, '25000.0000000000000000');
  assert.equal(kernel.inspect('alice').windowRemaining, '0.0000000000000000');
  // One more minimal transfer exceeds the limit.
  const over = await kernel.transfer('alice', 'bob', 'BTC', '0.00000001', 'q2');
  assert.deepEqual(over, { status: 'rejected', key: 'q2', reason: 'LIMIT_EXCEEDED' });
});

test('rolling window excludes transfers exactly 24h old', async () => {
  const { kernel, clock, gate } = makeKernel({});
  const first = (await commitTransfer(
    kernel, gate, 'alice', 'bob', 'BTC', '1.00000000', 'w1',
  )) as TransferSuccess;
  const t0 = first.committedAt;

  clock.advance(DAY_MS - 1);
  assert.equal(kernel.inspect('alice').windowUsed, '20000.0000000000000000');
  const tooSoon = await kernel.transfer('alice', 'bob', 'BTC', '0.50000000', 'w2');
  assert.deepEqual(tooSoon, { status: 'rejected', key: 'w2', reason: 'LIMIT_EXCEEDED' });

  clock.advance(1); // now exactly t0 + 24h
  assert.equal(kernel.inspect('alice').windowUsed, '0.0000000000000000');
  const after = await commitTransfer(kernel, gate, 'alice', 'bob', 'BTC', '0.50000000', 'w3');
  assert.equal(after.status, 'success');
  assert.equal(kernel.inspect('alice').windowUsed, '10000.0000000000000000');
  assert.equal(clock.now(), t0 + DAY_MS);
});

test('hook pause: commit uses rates and clock as of resume, history stays fixed', async () => {
  const { kernel, clock, gate } = makeKernel({});
  // t0: 1 BTC valued 20000 USDT.
  const first = (await commitTransfer(
    kernel, gate, 'alice', 'bob', 'BTC', '1.00000000', 'h1',
  )) as TransferSuccess;
  const t0 = first.committedAt;
  assert.equal(first.valuation, '20000.0000000000000000');

  // t0 + 1h: start a 0.25 BTC transfer; precheck passes (20000 + 5000 = 25000).
  clock.advance(HOUR_MS);
  const pending = kernel.transfer('alice', 'carol', 'BTC', '0.25000000', 'h2');
  await tick();
  assert.equal(gate.paused, true);

  // While paused: double the BTC rate and jump exactly to the 24h boundary.
  kernel.setRates({ ...BASE_RATES, BTC: '40000.00000000' });
  clock.advance(DAY_MS - HOUR_MS); // now exactly t0 + 24h
  gate.release();
  const second = (await pending) as TransferSuccess;

  // Commit-time state applies: first transfer aged out at the exact boundary,
  // and the new rate values this transfer at 0.25 * 40000 = 10000 USDT.
  assert.equal(second.status, 'success');
  assert.equal(second.valuation, '10000.0000000000000000');
  assert.equal(second.committedAt, t0 + DAY_MS);
  assert.equal(kernel.inspect('alice').windowUsed, '10000.0000000000000000');

  // Historical valuation is never rewritten by later rate changes.
  kernel.setRates({ ...BASE_RATES, BTC: '1.00000000' });
  assert.equal(kernel.inspect('alice').windowUsed, '10000.0000000000000000');
  const replay = await kernel.transfer('alice', 'bob', 'BTC', '1.00000000', 'h1');
  assert.deepEqual(replay, first);
});

test('hook pause: commit-time revalidation can reject after precheck passed', async () => {
  const { kernel, clock, gate } = makeKernel({});
  await commitTransfer(kernel, gate, 'alice', 'bob', 'BTC', '1.00000000', 'r1');
  clock.advance(HOUR_MS);

  const pending = kernel.transfer('alice', 'carol', 'BTC', '0.25000000', 'r2');
  await tick();
  assert.equal(gate.paused, true);

  // Rate spike makes the window sum 20000 + 25000 > 25000 at commit time.
  kernel.setRates({ ...BASE_RATES, BTC: '100000.00000000' });
  gate.release();
  const result = await pending;
  assert.deepEqual(result, { status: 'rejected', key: 'r2', reason: 'LIMIT_EXCEEDED' });

  // Rejection changed nothing financially.
  assert.equal(kernel.inspect('alice').balances.BTC, '8.99900000');
  assert.equal(kernel.inspect('carol').balances.BTC, '0.00000000');
  assert.equal(kernel.inspect(TREASURY).balances.BTC, '0.00100000');
  assert.equal(kernel.inspect('alice').windowUsed, '20000.0000000000000000');
});

test('same-key retry is a no-op; different payload conflicts', async () => {
  const { kernel, clock, gate } = makeKernel({});
  const first = (await commitTransfer(
    kernel, gate, 'alice', 'bob', 'BTC', '1.00000000', 'k1',
  )) as TransferSuccess;
  const balancesAfter = kernel.inspect('alice').balances.BTC;

  // Same payload: first result returned, no second financial effect even
  // after rates, balances and the window have moved on.
  kernel.setRates({ ...BASE_RATES, BTC: '50000.00000000' });
  clock.advance(DAY_MS * 7);
  const replay = await kernel.transfer('alice', 'bob', 'BTC', '1.00000000', 'k1');
  assert.deepEqual(replay, first);
  assert.equal(kernel.inspect('alice').balances.BTC, balancesAfter);
  assert.equal(kernel.inspect('alice').windowUsed, '0.0000000000000000');

  // Different payload under the same key conflicts and changes nothing.
  const conflictAmount = await kernel.transfer('alice', 'bob', 'BTC', '2.00000000', 'k1');
  assert.deepEqual(conflictAmount, { status: 'conflict', key: 'k1' });
  const conflictRecipient = await kernel.transfer('alice', 'carol', 'BTC', '1.00000000', 'k1');
  assert.deepEqual(conflictRecipient, { status: 'conflict', key: 'k1' });
  assert.equal(kernel.inspect('alice').balances.BTC, balancesAfter);
});

test('keys are scoped per sender', async () => {
  const { kernel, gate } = makeKernel({
    balances: {
      alice: { USDT: '100.00000000' },
      bob: { USDT: '100.00000000' },
      carol: {},
    },
  });
  const fromAlice = await commitTransfer(kernel, gate, 'alice', 'carol', 'USDT', '1.00000000', 'k');
  assert.equal(fromAlice.status, 'success');
  // The same key is free for another sender.
  const fromBob = await commitTransfer(kernel, gate, 'bob', 'carol', 'USDT', '9.00000000', 'k');
  assert.equal(fromBob.status, 'success');
  assert.equal(kernel.inspect('carol').balances.USDT, '10.00000000');
});

test('rejected results are pinned to their key as well', async () => {
  const { kernel, clock, gate } = makeKernel({});
  await commitTransfer(kernel, gate, 'alice', 'bob', 'BTC', '1.00000000', 'x1');
  // 20000 + 20000 > 25000: rejected without ever reaching the hook.
  const rejected = await kernel.transfer('alice', 'bob', 'BTC', '1.00000000', 'x2');
  assert.deepEqual(rejected, { status: 'rejected', key: 'x2', reason: 'LIMIT_EXCEEDED' });

  // Window clears and rates drop; the recorded rejection still stands.
  clock.advance(DAY_MS * 2);
  kernel.setRates({ ...BASE_RATES, BTC: '1.00000000' });
  const replay = await kernel.transfer('alice', 'bob', 'BTC', '1.00000000', 'x2');
  assert.deepEqual(replay, rejected);
  // A different amount under the same key conflicts.
  const conflict = await kernel.transfer('alice', 'bob', 'BTC', '0.50000000', 'x2');
  assert.deepEqual(conflict, { status: 'conflict', key: 'x2' });
});

test('concurrent retries of one key commit exactly once', async () => {
  const { kernel, gate } = makeKernel({});
  const p1 = kernel.transfer('alice', 'bob', 'BTC', '1.00000000', 'c1');
  await tick();
  const p2 = kernel.transfer('alice', 'bob', 'BTC', '1.00000000', 'c1');
  await tick();
  // Both attempts passed precheck and are parked in the hook.
  assert.equal(gate.calls, 2);
  gate.release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'success');
  assert.deepEqual(r2, r1);
  // Exactly one financial effect despite two in-flight attempts.
  assert.equal(kernel.inspect('alice').balances.BTC, '8.99900000');
  assert.equal(kernel.inspect('bob').balances.BTC, '1.00000000');
  assert.equal(kernel.inspect(TREASURY).balances.BTC, '0.00100000');
  assert.equal(kernel.inspect('alice').windowUsed, '20000.0000000000000000');
});

test('valuation keeps the exact product without rounding', async () => {
  const { kernel, gate } = makeKernel({
    balances: {
      alice: { XRP: '100000.00000000' },
      bob: {},
    },
    rates: { ...BASE_RATES, XRP: '0.51234567' },
  });
  const result = (await commitTransfer(
    kernel, gate, 'alice', 'bob', 'XRP', '1.23456789', 'v1',
  )) as TransferSuccess;
  // 123456789e-8 XRP * 51234567e-8 USDT/XRP, exact 1e-16 product.
  const expected = (123_456_789n * 51_234_567n).toString().padStart(17, '0');
  const formatted = `${expected.slice(0, -16)}.${expected.slice(-16)}`;
  assert.equal(result.valuation, formatted);
  assert.equal(kernel.inspect('alice').windowUsed, formatted);
});

test('setRates replaces the table atomically and validates fully', async () => {
  const { kernel, gate } = makeKernel({});
  // A table with a bad entry throws and leaves the old table untouched.
  assert.throws(() => kernel.setRates({ ...BASE_RATES, BTC: 'not-a-number' }));
  assert.throws(() => kernel.setRates({ ...BASE_RATES, BTC: '0.00000000' }));
  assert.throws(() => kernel.setRates({ BTC: '1.00000000' } as unknown as Rates));
  const result = (await commitTransfer(
    kernel, gate, 'alice', 'bob', 'BTC', '0.10000000', 's1',
  )) as TransferSuccess;
  assert.equal(result.valuation, '2000.0000000000000000'); // old rate still in force
});

test('limit spans tokens and recipients; fees never consume quota', async () => {
  const { kernel, gate } = makeKernel({});
  // 1 BTC (20000) + 5000 USDT to a different recipient = exactly 25000.
  await commitTransfer(kernel, gate, 'alice', 'bob', 'BTC', '1.00000000', 'm1');
  const usdt = await commitTransfer(kernel, gate, 'alice', 'carol', 'USDT', '5000.00000000', 'm2');
  assert.equal(usdt.status, 'success');
  assert.equal(kernel.inspect('alice').windowUsed, '25000.0000000000000000');
  // The smallest extra transfer in any token, to any recipient, is rejected.
  const extra = await kernel.transfer('alice', 'carol', 'USDT', '0.00000001', 'm3');
  assert.deepEqual(extra, { status: 'rejected', key: 'm3', reason: 'LIMIT_EXCEEDED' });
});

test('insufficient funds rejects without touching any balance', async () => {
  const { kernel } = makeKernel({
    balances: {
      alice: { USDT: '1.00000000' },
      bob: {},
    },
  });
  // Principal 1 USDT + 0.001 fee exceeds the 1 USDT balance.
  const result = await kernel.transfer('alice', 'bob', 'USDT', '1.00000000', 'b1');
  assert.deepEqual(result, { status: 'rejected', key: 'b1', reason: 'INSUFFICIENT_FUNDS' });
  assert.equal(kernel.inspect('alice').balances.USDT, '1.00000000');
  assert.equal(kernel.inspect('bob').balances.USDT, '0.00000000');
  assert.equal(kernel.inspect(TREASURY).balances.USDT, '0.00000000');
});

test('structural rejections: amount, token, wallets', async () => {
  const { kernel, gate } = makeKernel({});
  assert.deepEqual(
    await kernel.transfer('alice', 'bob', 'BTC', '1.000000001', 'e1'),
    { status: 'rejected', key: 'e1', reason: 'INVALID_AMOUNT' },
  );
  assert.deepEqual(
    await kernel.transfer('alice', 'bob', 'BTC', '0.00000000', 'e2'),
    { status: 'rejected', key: 'e2', reason: 'INVALID_AMOUNT' },
  );
  assert.deepEqual(
    await kernel.transfer('alice', 'bob', 'BTC', '-1.00000000', 'e3'),
    { status: 'rejected', key: 'e3', reason: 'INVALID_AMOUNT' },
  );
  assert.deepEqual(
    await kernel.transfer('alice', 'bob', 'DOGE' as Token, '1.00000000', 'e4'),
    { status: 'rejected', key: 'e4', reason: 'UNKNOWN_TOKEN' },
  );
  assert.deepEqual(
    await kernel.transfer('alice', 'alice', 'BTC', '1.00000000', 'e5'),
    { status: 'rejected', key: 'e5', reason: 'SAME_WALLET' },
  );
  assert.deepEqual(
    await kernel.transfer('alice', 'nobody', 'BTC', '1.00000000', 'e6'),
    { status: 'rejected', key: 'e6', reason: 'UNKNOWN_WALLET' },
  );
  // None of these reached the hook or changed state.
  assert.equal(gate.calls, 0);
  assert.equal(kernel.inspect('alice').balances.BTC, '10.00000000');
});
