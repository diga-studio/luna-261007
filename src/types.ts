/** 一条保管事件。seq 为追加时分配的全局递增序号（从 1 开始）。 */
export interface CustodyEvent {
  seq: number;
  recordId: string;
  /** UTC 秒级时间戳 */
  timestamp: number;
  operator: string;
  body: string;
}

/** 追加事件时上层提供的输入（seq 由库分配）。 */
export interface EventInput {
  recordId: string;
  timestamp: number;
  operator: string;
  body: string;
}

/** 封存凭证：不超过 128 字节的不透明字节串，由调用方另行保管。 */
export type Credential = Uint8Array;

/** 报告中携带的事件（与账册中存储的一致）。 */
export interface ReportEvent {
  seq: number;
  timestamp: number;
  operator: string;
  body: string;
}

/** 单条 Merkle 包含证明。 */
export interface InclusionProof {
  leafIndex: number;
  leafCount: number;
  /** 自叶向根逐层的兄弟哈希（hex）。 */
  siblings: string[];
}

/** 目录叶内容：某记录的链头承诺。 */
export interface LeafData {
  /** sha256(recordId) 的 hex */
  key: string;
  count: number;
  /** 记录链头哈希 hex */
  head: string;
}

/** 空报告的不存在证明：key 应落入的相邻叶（边界时只有一个）。 */
export interface NonMembershipProof {
  leafCount: number;
  left: { leaf: LeafData; proof: InclusionProof } | null;
  right: { leaf: LeafData; proof: InclusionProof } | null;
}

/** 报告校验材料（不含事件本身）。 */
export interface ReportProof {
  /** 非空报告：目标记录叶的包含证明 */
  inclusion: { leaf: LeafData; proof: InclusionProof } | null;
  /** 空报告：不存在证明 */
  nonMembership: NonMembershipProof | null;
}

/** 面向审查方的完整报告。 */
export interface CustodyReport {
  version: 1;
  recordId: string;
  /** 按 (timestamp, seq) 升序排列 */
  events: ReportEvent[];
  proof: ReportProof;
}
