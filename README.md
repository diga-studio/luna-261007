# JourneyPulse Ordered Journey Attribution

TypeScript library for ordered journey attribution over deduplicated,
fraud-free event streams. Exact matching and exact statistics only.

## API

- `compileJourney(definition)` — compiles a journey definition of up to 20
  stages. Each stage has an `eventType`, optional `properties` scalar
  equality conditions, and a `count` (first stage must be 1, later stages
  1–3, default 1).
- `analyzeJourney(compiled, events, range)` — runs the analysis. `range` is
  a half-open `[start, end)` window (integer milliseconds) restricting only
  the entry (first-stage) events; later completion events are unrestricted.
  Events are grouped by `customerId`; a path only uses one customer's
  events. Returns per-stage arrival counts, adjacent-stage conversion
  rates, and transition-time medians over the selected paths, counted per
  entry attempt.
- `explainAttempt(result, entryEventId)` — returns the completion
  `eventId` of each reached stage for that entry's selected path, or
  `null` if the event is not an entry in range.

## Semantics

- Every event matching the first stage inside `range` starts an
  independent attempt.
- Each later stage greedily collects `count` matching events in order
  after the previous stage's completion; the last one is the completion
  event. Consecutive completions must be at most 30 minutes apart
  (inclusive). Matching events may be skipped; events are never reused
  across stages within an attempt, but different attempts may share
  events.
- Each entry selects a path reaching the most stages with no skipped
  stages. Ties are broken by the lexicographically earliest completion
  events (by `timestamp`, then `eventId`) from stage 2 onward.

## Develop

```sh
npm install
npm test
```

`npm test` compiles with `tsc` and runs the `node:test` suite, including
a 200k-event / 20-stage scale test that must finish well under 30 seconds.
