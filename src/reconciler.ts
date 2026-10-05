import { ImportRow, InventoryRecord, Reconciler, RowConclusion } from "./types";
import { maxWeightMatching, NEG_INF } from "./matching";

type EvidenceLevel = "token" | "hostname" | "ip";

function evidenceLevel(
  row: ImportRow,
  record: InventoryRecord
): EvidenceLevel | null {
  if (row.agentToken !== undefined) {
    return row.agentToken === record.agentToken ? "token" : null;
  }
  if (row.hostname === record.hostname && row.site === record.site) {
    return "hostname";
  }
  if (row.ip === record.ip && row.site === record.site) {
    return "ip";
  }
  return null;
}

export function createReconciler(
  existing: readonly InventoryRecord[]
): Reconciler {
  const endpoints = existing.slice();

  return {
    reconcile(rows: readonly ImportRow[]): RowConclusion[] {
      const rowCount = rows.length;
      const endpointCount = endpoints.length;
      // Lexicographic weights: one higher-level association outweighs any
      // number of lower-level ones (counts are bounded by base - 1).
      const base = rowCount + endpointCount + 1;
      const levelWeight: Record<EvidenceLevel, number> = {
        token: base * base,
        hostname: base,
        ip: 1,
      };

      // edgeWeight[r][e]: weight of the candidate edge, undefined if none.
      const edgeWeight: (number | undefined)[][] = rows.map((row) =>
        endpoints.map((record) => {
          const level = evidenceLevel(row, record);
          return level === null ? undefined : levelWeight[level];
        })
      );

      // Optimal total weight over the given row/endpoint subsets. Each row
      // also gets a private zero-weight dummy column (leaving it unmatched).
      const solve = (
        rowIndexes: number[],
        endpointIndexes: number[]
      ): number => {
        const n = rowIndexes.length;
        const weights: number[][] = [];
        for (let i = 0; i < n; i++) {
          const r = rowIndexes[i] as number;
          const line: number[] = [];
          for (const e of endpointIndexes) {
            const w = (edgeWeight[r] as (number | undefined)[])[e];
            line.push(w === undefined ? NEG_INF : w);
          }
          for (let j = 0; j < n; j++) {
            line.push(j === i ? 0 : NEG_INF);
          }
          weights.push(line);
        }
        const match = maxWeightMatching(weights);
        let total = 0;
        for (let i = 0; i < n; i++) {
          const col = match[i] as number;
          if (col >= 0 && col < endpointIndexes.length) {
            const w = (weights[i] as number[])[col] as number;
            if (w > NEG_INF / 2) total += w;
          }
        }
        return total;
      };

      const allRows = rows.map((_, i) => i);
      const allEndpoints = endpoints.map((_, i) => i);
      const optimum = solve(allRows, allEndpoints);

      return rows.map((_, r) => {
        const otherRows = allRows.filter((i) => i !== r);
        const canBeUnmatched = solve(otherRows, allEndpoints) === optimum;

        const possibleEndpointIds: string[] = [];
        for (const e of allEndpoints) {
          const w = (edgeWeight[r] as (number | undefined)[])[e];
          if (w === undefined) continue;
          const remainingEndpoints = allEndpoints.filter((i) => i !== e);
          if (w + solve(otherRows, remainingEndpoints) === optimum) {
            const id = (endpoints[e] as InventoryRecord).endpointId;
            possibleEndpointIds.push(id);
          }
        }
        possibleEndpointIds.sort();

        let kind: RowConclusion["kind"];
        if (possibleEndpointIds.length === 1 && !canBeUnmatched) {
          kind = "matched";
        } else if (possibleEndpointIds.length === 0 && canBeUnmatched) {
          kind = "new";
        } else {
          kind = "ambiguous";
        }
        return { kind, possibleEndpointIds, canBeUnmatched };
      });
    },
  };
}
