/** Exact rational helpers. All money math uses BigInt; no binary floats anywhere. */

/** roundHalfUp(num / den) for non-negative num and positive den. Exact halves round up. */
export function roundHalfUp(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

export interface AllocatableLine {
  /** Unrounded amount in fine units; `unitsPerCent` fine units make one cent. */
  units: bigint;
}

/**
 * Largest-remainder allocation: rounds every line to integer cents so that the
 * rounded values sum exactly to `totalCents`. Each line ends up within 1 cent of
 * its unrounded value. Ties on the fractional remainder break by input position,
 * so callers must pass lines in a deterministic (sorted) order.
 */
export function allocateCents(lines: AllocatableLine[], unitsPerCent: bigint, totalCents: bigint): bigint[] {
  const floors = lines.map((l) => l.units / unitsPerCent);
  const remainders = lines.map((l) => l.units % unitsPerCent);
  let distributed = floors.reduce((a, b) => a + b, 0n);
  let remaining = totalCents - distributed;
  const order = lines.map((_, i) => i).sort((a, b) => {
    if (remainders[a] !== remainders[b]) return remainders[a]! > remainders[b]! ? -1 : 1;
    return a - b;
  });
  const result = [...floors];
  for (const i of order) {
    if (remaining <= 0n) break;
    result[i] = result[i]! + 1n;
    remaining -= 1n;
  }
  return result;
}
