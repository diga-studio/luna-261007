export type Id = string | number;

export interface DedupRecord {
  id: Id;
  value: string;
}

export interface Cluster {
  ids: Id[];
}

export interface ClusterStats {
  distanceChecks: number;
}

export interface ClusterResult {
  clusters: Cluster[];
  stats: ClusterStats;
}
