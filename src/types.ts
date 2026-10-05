export type Percentage = 10 | 25 | 50 | 100;

export type Renderer = (nodeId: string, text: string) => Promise<string>;

export interface VersionRecord {
  readonly versionId: string;
  readonly text: string;
}

export interface BatchRecord {
  readonly batchId: string;
  readonly versionId: string;
  readonly percentage: Percentage;
  readonly candidates: readonly string[];
  readonly members: ReadonlySet<string>;
  readonly createdSeq: number;
  withdrawn: boolean;
}
