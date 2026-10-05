/**
 * Unit-cost Levenshtein distance (insert / delete / substitute only;
 * adjacent transposition is NOT a single edit).
 *
 * When `maxDistance` is provided, the computation uses a banded DP and
 * may stop early: if the true distance exceeds `maxDistance`, a value
 * greater than `maxDistance` is returned (the exact distance is not
 * guaranteed in that case).
 */
export function levenshtein(a: string, b: string, maxDistance?: number): number {
  if (a === b) return 0;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0) return lenB;
  if (lenB === 0) return lenA;

  const limit = maxDistance === undefined ? Math.max(lenA, lenB) : maxDistance;
  if (limit < 0) return 1;
  // Length difference alone already exceeds the allowed distance.
  if (Math.abs(lenA - lenB) > limit) return limit + 1;

  // Banded DP over rows of `a`; only cells with |i - j| <= limit can
  // hold values <= limit, everything else stays above the limit.
  const row = new Array<number>(lenB + 1);
  for (let j = 0; j <= lenB; j++) row[j] = j;

  for (let i = 1; i <= lenA; i++) {
    const bandLo = Math.max(1, i - limit);
    const bandHi = Math.min(lenB, i + limit);
    // Diagonal cell (i-1, bandLo-1): still stored from the previous row.
    let prev: number;
    if (bandLo === 1) {
      prev = row[0];
      row[0] = i;
    } else {
      prev = row[bandLo - 1];
    }
    let rowMin = bandLo === 1 ? row[0] : limit + 1;
    const charA = a.charCodeAt(i - 1);
    for (let j = bandLo; j <= bandHi; j++) {
      const up = row[j];
      const cost = charA === b.charCodeAt(j - 1) ? 0 : 1;
      let value = prev + cost; // substitute / match
      if (up + 1 < value) value = up + 1; // delete from b
      const left = j === bandLo && bandLo > 1 ? limit + 1 : row[j - 1];
      if (left + 1 < value) value = left + 1; // insert into b
      row[j] = value;
      prev = up;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1; // early exit
  }
  return row[lenB];
}
