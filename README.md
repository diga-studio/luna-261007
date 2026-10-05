# WorkForge Payroll

Multi-rate overtime pay-run engine for a single client's weekly or biweekly payroll.

## Usage

```ts
import { calculatePayRun } from "./src/index.js";

const result = calculatePayRun(periodStart, weeks, shifts, rules);
```

- `periodStart`: local date string of the Monday the pay period starts on (`"2026-10-05"`).
- `weeks`: `1` (weekly) or `2` (biweekly). Biweekly runs settle each week independently.
- `shifts`: work records with employee, site, job, local start/end (whole minutes,
  may cross midnight or week boundaries), base hourly rate in integer cents and a
  shift differential in integer basis points (100 bps = 1%).
- `rules`: per site/job minimum hourly rates (integer cents) and a daily-overtime toggle.

Returns one pay line per (employee, week, site, job) with regular / daily-OT /
weekly-OT minutes, base pay and OT premium in integer cents, plus per-employee
period totals. All money math is exact rational arithmetic (BigInt); weekly
amounts round half-up to cents and line-level cents are distributed by largest
remainder, so lines always sum to the weekly totals. Results are independent of
input order and of how records are losslessly split.

## Develop

```sh
npm install
npm test
```
