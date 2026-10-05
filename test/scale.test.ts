import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LogicalClock, MarketingAutomation } from '../src/index.ts';
import { ControlledSimulator } from './helpers.ts';

test('10k unfinished chains with concurrent advancement stay consistent and fast', async () => {
  const clock = new LogicalClock();
  const sim = new ControlledSimulator();
  const engine = new MarketingAutomation(sim.simulator, clock);

  const submissions = [];
  for (let i = 0; i < 10_000; i += 1) {
    const subscriberId = `u${i}`;
    submissions.push(engine.submitEvent({ kind: 'consent', subscriberId, eventId: `c${i}` }));
    submissions.push(
      engine.submitEvent({
        kind: 'trigger',
        subscriberId,
        eventId: `t${i}`,
        plan: [{ content: 'm', delayMs: 0 }],
      }),
    );
  }
  await Promise.all(submissions);
  assert.equal(engine.getChains().length, 10_000);

  const started = Date.now();
  const results = await Promise.all(Array.from({ length: 50 }, () => engine.advanceQueue()));
  const elapsed = Date.now() - started;
  const totalStarted = results.reduce((sum, r) => sum + r.startedAttempts, 0);
  assert.equal(totalStarted, 10_000);
  assert.equal(sim.calls.length, 10_000);
  assert.ok(elapsed < 1_000, `advancement took ${elapsed}ms`);

  const records = engine
    .getChains()
    .flatMap((chain) => engine.getAttempts(chain.chainId));
  assert.equal(records.length, sim.calls.length);
});
