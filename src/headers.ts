import type { HeaderInfo } from './types';
import type { Cell, Model } from './model';

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** 显式关联：保持给定次序，每个编号只保留首次出现。 */
function resolveExplicit(model: Model, ids: readonly string[]): HeaderInfo[] {
  const seen = new Set<string>();
  const result: HeaderInfo[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const header = model.byId.get(id);
    if (header !== undefined) {
      result.push({ id: header.id, text: header.text });
    }
  }
  return result;
}

/** 自动关联：以目标格整个覆盖范围为准。 */
function resolveAutomatic(model: Model, target: Cell): HeaderInfo[] {
  const colHeaders: Cell[] = [];
  const rowHeaders: Cell[] = [];
  for (const cell of model.cells) {
    if (cell === target) {
      continue;
    }
    if (
      cell.kind === 'col-header' &&
      cell.rowEnd < target.rowStart &&
      overlaps(cell.colStart, cell.colEnd, target.colStart, target.colEnd)
    ) {
      colHeaders.push(cell);
    } else if (
      cell.kind === 'row-header' &&
      cell.colEnd < target.colStart &&
      overlaps(cell.rowStart, cell.rowEnd, target.rowStart, target.rowEnd)
    ) {
      rowHeaders.push(cell);
    }
  }
  colHeaders.sort((a, b) => a.rowStart - b.rowStart || a.colStart - b.colStart);
  rowHeaders.sort((a, b) => a.colStart - b.colStart || a.rowStart - b.rowStart);
  const toInfo = (cell: Cell): HeaderInfo => ({ id: cell.id, text: cell.text });
  return [...colHeaders.map(toInfo), ...rowHeaders.map(toInfo)];
}

/** 计算目标格的有序表头。 */
export function computeHeaders(model: Model, target: Cell): HeaderInfo[] {
  if (target.explicitHeaders !== undefined) {
    return resolveExplicit(model, target.explicitHeaders);
  }
  return resolveAutomatic(model, target);
}
