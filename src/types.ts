/** 一条保管事件（追加后不可变）。 */
export interface CustodyEvent {
  /** 全局唯一递增序号，从 1 开始。 */
  seq: number;
  /** 记录标识。 */
  recordId: string;
  /** UTC 秒级时间戳。 */
  timestamp: number;
  /** 操作者。 */
  actor: string;
  /** 事件正文。 */
  body: Uint8Array;
}

/** 追加事件时的输入；timestamp 省略时取当前 UTC 秒。 */
export interface EventInput {
  recordId: string;
  timestamp?: number;
  actor: string;
  body: Uint8Array | string;
}

/** 封存凭证，原始字节不超过 128 字节。 */
export type Credential = Uint8Array;

/** Merkle 路径中的一个兄弟节点。 */
export interface MerklePathStep {
  /** 兄弟节点哈希（32 字节）。 */
  hash: Uint8Array;
  /** true 表示兄弟在右侧。 */
  siblingOnRight: boolean;
}

/** 记录存在性证明：叶子的纳入证明。 */
export interface InclusionProof {
  kind: 'inclusion';
  leafIndex: number;
  leafCount: number;
  /** 该记录的保管链头哈希。 */
  recordHead: Uint8Array;
  path: MerklePathStep[];
}

/** 记录不存在证明：排序叶子中相邻左右叶子的纳入证明。 */
export interface ExclusionProof {
  kind: 'exclusion';
  leafCount: number;
  left: { leafIndex: number; recordId: string; recordHead: Uint8Array; path: MerklePathStep[] } | null;
  right: { leafIndex: number; recordId: string; recordHead: Uint8Array; path: MerklePathStep[] } | null;
}

export type RecordProof = InclusionProof | ExclusionProof;

/** 单条记录的报告。 */
export interface CustodyReport {
  version: number;
  recordId: string;
  /** 目标记录的全部事件，按 (timestamp, seq) 升序。 */
  events: CustodyEvent[];
  /** 校验材料。 */
  proof: RecordProof;
}
