# dataforge-dedup

Fuzzy duplicate clustering for DataForge. Records are `{ id, value }` where
`value` is a normalized lowercase string of length 8-32.

## API

- `similarity(a, b)` — `1 - levenshtein(a, b) / max(lenA, lenB)` with
  unit-cost insert/delete/substitute edits (transposition is not one edit).
- `cluster(records)` — returns `{ clusters, stats }`. Two records are
  similar iff `10 * d <= max(lenA, lenB)` (similarity >= 0.9). `clusters`
  is exactly the set of connected components (size >= 2) of that similarity
  graph, so transitively-linked records share a cluster. `stats.distanceChecks`
  counts every distance computation, including early-exited ones.

## Implementation notes

No all-pairs enumeration: identical values are merged first, then a
pigeonhole segment index (each value split into 4 contiguous segments; any
pair within edit distance 3 shares one) retrieves candidates, and only
candidates get an exact banded Levenshtein check with early exit. The
filter is exact — it never prunes a pair that meets the threshold.

## Develop

```
npm install
npm test
```
