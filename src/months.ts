/** 月份工具：以 "YYYY-MM" 字符串与线性月份序号互转。 */

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 将 "YYYY-MM" 解析为线性月份序号（year*12 + (month-1)）。 */
export function parseMonth(month: string): number {
  const match = MONTH_PATTERN.exec(month);
  if (!match) {
    throw new Error(`invalid month format: ${JSON.stringify(month)}, expected "YYYY-MM"`);
  }
  const year = Number(match[1]);
  const monthOfYear = Number(match[2]);
  return year * 12 + (monthOfYear - 1);
}

/** 将线性月份序号格式化为 "YYYY-MM"。 */
export function formatMonth(index: number): string {
  const year = Math.floor(index / 12);
  const monthOfYear = (index % 12) + 1;
  return `${year.toString().padStart(4, "0")}-${monthOfYear.toString().padStart(2, "0")}`;
}

/** 返回从 start 到 end（含两端）的全部月份序号。 */
export function monthRange(start: number, end: number): number[] {
  const result: number[] = [];
  for (let index = start; index <= end; index += 1) {
    result.push(index);
  }
  return result;
}
