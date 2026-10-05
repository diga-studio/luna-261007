import type { ColumnType } from './types.js';
import {
  hasEdgeWhitespace,
  matchBoolean,
  matchDate,
  matchEmail,
  matchFloat,
  matchInteger,
  matchUrl,
} from './typeMatchers.js';

/** 判型优先级：取第一个命中比例达标的非 text 类型。 */
const CANDIDATE_ORDER = ['boolean', 'integer', 'float', 'date', 'url', 'email'] as const;
type CandidateType = (typeof CANDIDATE_ORDER)[number];
const CANDIDATE_INDEX = new Map<CandidateType, number>(
  CANDIDATE_ORDER.map((t, i) => [t, i]),
);

const MATCHERS: Record<CandidateType, (value: string) => boolean> = {
  boolean: matchBoolean,
  integer: matchInteger,
  float: matchFloat,
  date: matchDate,
  url: matchUrl,
  email: matchEmail,
};

interface ColumnStats {
  /** 非空样本数（判型分母）。 */
  nonEmpty: number;
  /** 各候选类型命中数，下标与 CANDIDATE_ORDER 对应。 */
  hits: number[];
}

/** 采样检测器：累计采样数据记录后判定每列类型。 */
export class TypeDetector {
  private readonly stats: ColumnStats[];

  constructor(columnCount: number) {
    this.stats = Array.from({ length: columnCount }, () => ({
      nonEmpty: 0,
      hits: new Array<number>(CANDIDATE_ORDER.length).fill(0),
    }));
  }

  /** 累计一条采样记录。 */
  addRecord(cells: string[]): void {
    for (let i = 0; i < this.stats.length; i++) {
      const value = cells[i]!;
      if (value === '') continue; // 空值不计入分母
      const stat = this.stats[i]!;
      stat.nonEmpty++;
      if (hasEdgeWhitespace(value)) continue; // 首尾空白只能匹配 text
      for (const type of CANDIDATE_ORDER) {
        if (MATCHERS[type](value)) {
          const idx = CANDIDATE_INDEX.get(type)!;
          stat.hits[idx] = stat.hits[idx]! + 1;
        }
      }
    }
  }

  /** 采样结束（满 100 条或流结束），返回每列类型。 */
  finalize(): ColumnType[] {
    return this.stats.map((stat) => {
      if (stat.nonEmpty === 0) return 'text'; // 全空列
      for (let t = 0; t < CANDIDATE_ORDER.length; t++) {
        // 命中比例 >= 80%（用整数运算避免浮点误差）
        if (stat.hits[t]! * 5 >= stat.nonEmpty * 4) {
          return CANDIDATE_ORDER[t]!;
        }
      }
      return 'text';
    });
  }
}
