import type { ImportRow, InventoryRecord, Reconciler, RowReconciliation } from "./types.js";

const TIER_TOKEN = 0;
const TIER_HOSTNAME = 1;
const TIER_IP = 2;
const TIER_COUNT = 3;

interface CandidateEdge {
  readonly endpointIndex: number;
  readonly tier: number;
}

function compareLex(a: readonly number[], b: readonly number[]): number {
  for (let t = 0; t < TIER_COUNT; t++) {
    const av = a[t] ?? 0;
    const bv = b[t] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function buildCandidates(
  row: ImportRow,
  inventory: readonly InventoryRecord[],
): CandidateEdge[] {
  const edges: CandidateEdge[] = [];
  for (let endpointIndex = 0; endpointIndex < inventory.length; endpointIndex++) {
    const record = inventory[endpointIndex];
    if (record === undefined) continue;
    if (row.agentToken !== undefined) {
      // A provided agentToken is decisive: mismatch forbids any association,
      // a match is token-tier evidence regardless of hostname/ip.
      if (row.agentToken !== record.agentToken) continue;
      edges.push({ endpointIndex, tier: TIER_TOKEN });
      continue;
    }
    if (row.hostname === record.hostname && row.site === record.site) {
      edges.push({ endpointIndex, tier: TIER_HOSTNAME });
      continue;
    }
    if (row.ip === record.ip && row.site === record.site) {
      edges.push({ endpointIndex, tier: TIER_IP });
    }
  }
  return edges;
}

export function createReconciler(existing: readonly InventoryRecord[]): Reconciler {
  const inventory = existing.slice();
  return {
    reconcile(rows: readonly ImportRow[]): RowReconciliation[] {
      const rowCount = rows.length;
      const edges = rows.map((row) => buildCandidates(row, inventory));

      // suffixPotential[i][t] = number of rows in [i, rowCount) that have at
      // least one candidate edge of tier t; an upper bound on how many more
      // tier-t associations any completion of a partial assignment can add.
      const suffixPotential: number[][] = Array.from({ length: rowCount + 1 }, () =>
        new Array<number>(TIER_COUNT).fill(0),
      );
      for (let i = rowCount - 1; i >= 0; i--) {
        const current = suffixPotential[i];
        const next = suffixPotential[i + 1];
        if (current === undefined || next === undefined) continue;
        for (let t = 0; t < TIER_COUNT; t++) current[t] = next[t] ?? 0;
        const rowEdges = edges[i];
        if (rowEdges === undefined) continue;
        const seen = new Set<number>();
        for (const edge of rowEdges) {
          if (seen.has(edge.tier)) continue;
          seen.add(edge.tier);
          current[edge.tier] = (current[edge.tier] ?? 0) + 1;
        }
      }

      const usedEndpoint = new Uint8Array(inventory.length);
      const counts = new Array<number>(TIER_COUNT).fill(0);
      const assignment = new Array<number>(rowCount).fill(-1);
      let best = new Array<number>(TIER_COUNT).fill(-1);
      const possibleSets: Array<Set<number>> = rows.map(() => new Set<number>());
      const canBeUnmatched = new Array<boolean>(rowCount).fill(false);

      const recordOptimum = (): void => {
        for (let i = 0; i < rowCount; i++) {
          const endpointIndex = assignment[i] as number;
          if (endpointIndex < 0) {
            canBeUnmatched[i] = true;
          } else {
            possibleSets[i]?.add(endpointIndex);
          }
        }
      };

      const dfs = (i: number): void => {
        if (i === rowCount) {
          const cmp = compareLex(counts, best);
          if (cmp > 0) {
            best = counts.slice();
            for (const set of possibleSets) set.clear();
            canBeUnmatched.fill(false);
            recordOptimum();
          } else if (cmp === 0) {
            recordOptimum();
          }
          return;
        }
        const potential = suffixPotential[i];
        if (potential !== undefined) {
          const optimistic = counts.map((c, t) => c + (potential[t] ?? 0));
          if (compareLex(optimistic, best) < 0) return;
        }
        // Option 1: leave this row unmatched.
        dfs(i + 1);
        // Option 2: associate it with a still-available candidate endpoint.
        const rowEdges = edges[i];
        if (rowEdges !== undefined) {
          for (const edge of rowEdges) {
            if (usedEndpoint[edge.endpointIndex] === 1) continue;
            usedEndpoint[edge.endpointIndex] = 1;
            counts[edge.tier] = (counts[edge.tier] ?? 0) + 1;
            assignment[i] = edge.endpointIndex;
            dfs(i + 1);
            assignment[i] = -1;
            counts[edge.tier] = (counts[edge.tier] ?? 0) - 1;
            usedEndpoint[edge.endpointIndex] = 0;
          }
        }
      };

      dfs(0);

      return rows.map((_, rowIndex) => {
        const possibleEndpointIds = [...(possibleSets[rowIndex] ?? [])]
          .map((endpointIndex) => inventory[endpointIndex]?.endpointId)
          .filter((id): id is string => id !== undefined)
          .sort();
        const unmatched = canBeUnmatched[rowIndex] === true;
        let verdict: RowReconciliation["verdict"];
        if (possibleEndpointIds.length === 1 && !unmatched) {
          verdict = "matched";
        } else if (possibleEndpointIds.length === 0 && unmatched) {
          verdict = "added";
        } else {
          verdict = "ambiguous";
        }
        return { rowIndex, verdict, possibleEndpointIds, canBeUnmatched: unmatched };
      });
    },
  };
}
