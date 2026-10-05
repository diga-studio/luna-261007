/**
 * Exact branch-and-bound selection of the optimal set of grants to keep.
 *
 * Objectives, in priority order:
 *  1. minimize |union of kept coverage| (equivalently the number of
 *     unobserved-but-allowed triples, since all evidence must stay covered);
 *  2. minimize the number of kept grants;
 *  3. lexicographically smallest ascending id sequence.
 *
 * Every evidence key must be covered by at least one kept grant.
 * The result is independent of input ordering.
 */

interface Candidate {
  readonly unionSize: number;
  readonly ids: readonly number[]; // ascending
}

function isBetter(candidate: Candidate, best: Candidate): boolean {
  if (candidate.unionSize !== best.unionSize) return candidate.unionSize < best.unionSize;
  if (candidate.ids.length !== best.ids.length) return candidate.ids.length < best.ids.length;
  for (let i = 0; i < candidate.ids.length; i++) {
    const a = candidate.ids[i]!;
    const b = best.ids[i]!;
    if (a !== b) return a < b;
  }
  return false;
}

export function selectGrantsToKeep(
  grantIds: readonly number[],
  coverages: readonly ReadonlySet<string>[],
  evidence: ReadonlySet<string>,
): number[] {
  if (grantIds.length !== coverages.length) {
    throw new Error('grantIds and coverages length mismatch');
  }

  // Canonical order: ascending id. Makes the result order-independent.
  const order = grantIds.map((_, i) => i).sort((a, b) => grantIds[a]! - grantIds[b]!);
  const ids = order.map((i) => grantIds[i]!);
  const covs = order.map((i) => coverages[i]!);
  const n = ids.length;

  // Suffix union of coverages: suffixUnion[i] = union of covs[i..n-1].
  const suffixUnion: Set<string>[] = new Array<Set<string>>(n + 1);
  suffixUnion[n] = new Set<string>();
  for (let i = n - 1; i >= 0; i--) {
    suffixUnion[i] = new Set<string>([...suffixUnion[i + 1]!, ...covs[i]!]);
  }

  // Feasibility of the full problem: all evidence must be coverable.
  for (const key of evidence) {
    if (!suffixUnion[0]!.has(key)) {
      throw new Error(`evidence triple is not covered by any grant: ${key}`);
    }
  }

  let best: Candidate | null = null;

  const dfs = (i: number, chosen: number[], union: Set<string>): void => {
    // Bound: union can only grow; every uncovered evidence key forces growth.
    if (best !== null) {
      let uncoveredEvidence = 0;
      for (const key of evidence) {
        if (!union.has(key)) uncoveredEvidence++;
      }
      if (union.size + uncoveredEvidence > best.unionSize) return;
      if (union.size === best.unionSize && uncoveredEvidence === 0 && chosen.length > best.ids.length) {
        return;
      }
    }

    // Feasibility: remaining grants must be able to cover all evidence.
    const remaining = suffixUnion[i]!;
    for (const key of evidence) {
      if (!union.has(key) && !remaining.has(key)) return;
    }

    if (i === n) {
      const candidate: Candidate = { unionSize: union.size, ids: [...chosen] };
      if (best === null || isBetter(candidate, best)) {
        best = candidate;
      }
      return;
    }

    // Branch 1: keep grant i.
    const id = ids[i]!;
    const cov = covs[i]!;
    const added: string[] = [];
    for (const key of cov) {
      if (!union.has(key)) {
        union.add(key);
        added.push(key);
      }
    }
    chosen.push(id);
    dfs(i + 1, chosen, union);
    chosen.pop();
    for (const key of added) union.delete(key);

    // Branch 2: revoke grant i.
    dfs(i + 1, chosen, union);
  };

  dfs(0, [], new Set<string>());

  if (best === null) {
    // Unreachable: the empty set is feasible whenever evidence is empty,
    // and non-empty evidence was validated against suffixUnion[0] above.
    throw new Error('no feasible keep set');
  }
  return [...(best as Candidate).ids];
}
