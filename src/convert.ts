import type { CellValue, ColumnType } from './types.js';
import { matchBoolean, matchFloat, matchInteger } from './typeMatchers.js';

export interface ConvertResult {
  value: CellValue;
  /** false 表示非空值无法按列类型转换，须保留原文并告警。 */
  ok: boolean;
}

/**
 * 按判定类型转换单个单元格。
 * 空值输出 null；boolean/integer/float 输出相应 JavaScript 值；
 * 其它类型保持解码后的原文；无法转换的非空值保留原文并标记 ok=false。
 */
export function convertCell(raw: string, type: ColumnType): ConvertResult {
  if (raw === '') return { value: null, ok: true };
  switch (type) {
    case 'boolean': {
      if (matchBoolean(raw)) {
        return { value: raw.toLowerCase() === 'true', ok: true };
      }
      return { value: raw, ok: false };
    }
    case 'integer':
      if (matchInteger(raw)) return { value: Number(raw), ok: true };
      return { value: raw, ok: false };
    case 'float':
      if (matchFloat(raw)) return { value: Number(raw), ok: true };
      return { value: raw, ok: false };
    default:
      // date、url、email、text 均保持原文。
      return { value: raw, ok: true };
  }
}
