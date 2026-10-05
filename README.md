# JourneyPulse

Ordered journey attribution library (TypeScript). Input events are expected
to be deduplicated and fraud-free; matching is exact and statistics are
computed over the selected path of every entry attempt.

## Install & test

```sh
npm install
npm test
```

Requires Node.js >= 18 and the dev dependencies in `package.json`
(`typescript`, `@types/node`). `npm test` compiles to `dist/` and runs the
compiled tests with the built-in Node test runner.

## API

```ts
import { compileJourney, analyzeJourney, explainAttempt } from "journeypulse";
```

### compileJourney(definition)

Validates and compiles a journey of 1 to 20 stages. Accepts an array of
stages or `{ stages: [...] }`. Each stage has:

- `eventType: string` — exact event type match.
- `properties?: Record<string, string | number | boolean>` — optional
  scalar equality conditions on event properties.
- `count?: number` — matching events needed to complete the stage.
  Stage 1 must be 1 (default); other stages allow 1..3. Defaults to 1.

### analyzeJourney(compiled, events, range)

- `events`: grouped by customer — an array of arrays, each inner array
  holding one customer's events sorted by `(timestamp, eventId)` ascending.
  A path only ever uses events of a single customer.
- `range`: `{ startInclusive, endExclusive }` — half-open time range that
  constrains only the entry (stage 1) event; later completions may fall
  outside it.

Every stage-1 match inside the range produces an independent attempt.
Later stages complete in event order after the previous stage's completion:
`count` matching events are selected (skipping is allowed, events are not
reused within an attempt) and the last one is the completion event. The gap
between consecutive stage completions must be <= 30 minutes, inclusive.

Each entry selects the path reaching the most stages (no stage skipping);
ties resolve to the lexicographically earliest sequence of completion
events (by `timestamp`, then `eventId`) starting from stage 2.

Returns per-stage statistics counted per entry (not per customer):
`arrivals`, `conversionFromPrevious`, and `medianTransitionMs`, plus the
total number of attempts.

### explainAttempt(result, entryEventId)

Returns the completion `eventId` of every stage reached by the selected
path of that entry (index 0 = stage 1). Throws if `entryEventId` is not an
entry of the analysis.

## Performance

Per customer, analysis runs a backward dynamic program with a monotonic
deque per stage — no per-entry rescanning, no path enumeration, no
materialized candidate edges. 200k events over 20 stages analyze in well
under a second (the test budget is 30 seconds).
