# liquidation-waterfall

In-process equity exit liquidation calculator with exact rational arithmetic.
Supports non-participating, uncapped participating, and capped participating
preferred stock at a single liquidation seniority. Conversion choice,
participation caps, and exact cash conservation are solved simultaneously
against a single per-share rate `r` — never decided independently and patched
up afterwards.

## Requirements

Node.js only. No runtime dependencies; `typescript` and `@types/node` are
devDependencies used for the build and tests.

```sh
npm install
npm test
```

## API

All share counts and amounts are decimal integer strings (or bigints);
amounts are in cents and may exceed 2^53. Results are exact rationals
`{ num: bigint, den: bigint }`, always reduced with `den > 0`.

```ts
import { allocate, breakpoints } from "liquidation-waterfall";

const table = {
  common: { id: "common", shares: "100" },
  preferred: [
    { id: "p1", shares: "100", preference: "100", participating: true, cap: "200" },
    { id: "p2", shares: "100", preference: "100", participating: false },
  ],
};

allocate(table, "900");
// common: 300/1; p1: 300/1 (converted); p2: 300/1 (converted)

breakpoints(table);
// [200/1, 400/1, 600/1]
```

- `allocate(table, exitValue)` — exact proceeds and conversion flag per
  class at a non-negative integer exit value. O(n log n).
- `breakpoints(table)` — every critical exit value (ascending, de-duplicated,
  excluding 0) where any class's slope vs. exit value or conversion state
  changes, including cap events that leave the aggregate rate unchanged.
  O(n log n) time, O(n) extra space.

## Model

For exit value at or below the aggregate preference `sum(L)`, preferred
classes share everything pro-rata to `L` and keep their status. Above it,
let `r` be the per-share common proceeds. Each class's optimal choice is
monotone in `r`:

- non-participating: converts once `r > L/s`;
- capped participating: stops participating at `r = (C-L)/s`, converts once
  `r > C/s`;
- uncapped participating: never converts (`L + s*r > s*r` always).

Total payout `P(r)` is therefore a continuous, strictly increasing,
piecewise-linear function whose kinks are exactly the class thresholds.
Both operations build these events, sort them once, and sweep — no
combination enumeration, no floats, no tolerance, no sampling. Ties at a
threshold keep the preferred status.
