/**
 * 增量 CSV 解析器：按任意边界接收已解码的字符串块，
 * 产出完整逻辑记录（字段数组）。
 *
 * 规则：逗号分隔；LF / CRLF 结束记录；双引号字段内逗号与换行
 * 原样保留；连续两个双引号表示一个字面双引号。输入保证语法合法。
 */
export class CsvRecordParser {
  private mode: "fieldStart" | "unquoted" | "quoted" | "quoteEnd" | "cr" =
    "fieldStart";
  private fields: string[] = [];
  private field = "";
  /** 上一块末尾在引号外遇到 CR，等待确认是否紧跟 LF。 */
  private pendingCr = false;

  /** 喂入一个字符串块。返回本块中完整解析出的逻辑记录。 */
  push(chunk: string): string[][] {
    const records: string[][] = [];
    let i = 0;
    if (this.pendingCr) {
      // 上一块以 CR 结尾：若本块以 LF 开头则吞掉，否则上一 CR 已单独结束记录。
      if (chunk.length > 0 && chunk.charCodeAt(0) === 0x0a) i = 1;
      this.endRecord(records);
      this.pendingCr = false;
    }
    const n = chunk.length;
    while (i < n) {
      const c = chunk.charCodeAt(i);
      switch (this.mode) {
        case "fieldStart":
          if (c === 0x22 /* " */) {
            this.mode = "quoted";
            i++;
          } else if (c === 0x2c /* , */) {
            this.endField();
            i++;
          } else if (c === 0x0a /* LF */) {
            this.endRecord(records);
            i++;
          } else if (c === 0x0d /* CR */) {
            this.pendingCr = true;
            i++;
          } else {
            this.mode = "unquoted";
          }
          break;
        case "unquoted": {
          // 扫描到下一个特殊字符，整段切出以减少拼接次数。
          let j = i;
          while (j < n) {
            const k = chunk.charCodeAt(j);
            if (k === 0x2c || k === 0x0a || k === 0x0d) break;
            j++;
          }
          this.field += chunk.slice(i, j);
          i = j;
          if (i < n) {
            const k = chunk.charCodeAt(i);
            if (k === 0x2c) {
              this.endField();
              this.mode = "fieldStart";
              i++;
            } else if (k === 0x0a) {
              this.endRecord(records);
              i++;
            } else {
              this.pendingCr = true;
              i++;
            }
          }
          break;
        }
        case "quoted": {
          // 引号内一切字符（含逗号、CR、LF）原样保留，只认双引号。
          let j = i;
          while (j < n && chunk.charCodeAt(j) !== 0x22) j++;
          this.field += chunk.slice(i, j);
          i = j;
          if (i < n) {
            this.mode = "quoteEnd";
            i++;
          }
          break;
        }
        case "quoteEnd":
          if (c === 0x22 /* " */) {
            // 连续两个双引号 -> 一个字面双引号。
            this.field += '"';
            this.mode = "quoted";
            i++;
          } else if (c === 0x2c) {
            this.endField();
            this.mode = "fieldStart";
            i++;
          } else if (c === 0x0a) {
            this.endRecord(records);
            i++;
          } else if (c === 0x0d) {
            this.pendingCr = true;
            i++;
          } else {
            // 合法输入不会走到这里；容错地按未引用内容继续。
            this.mode = "unquoted";
          }
          break;
        case "cr":
          // 不会到达：CR 统一经 pendingCr 在下次 push/end 处理。
          i++;
          break;
      }
      if (this.pendingCr && i < n) {
        // CR 后同块内还有数据：立即结束记录；若下一个是 LF 则一并吞掉。
        if (chunk.charCodeAt(i) === 0x0a) i++;
        this.endRecord(records);
        this.pendingCr = false;
      }
    }
    return records;
  }

  /** 输入结束。返回末尾（可无换行结尾）剩余的逻辑记录。 */
  end(): string[][] {
    const records: string[][] = [];
    if (this.pendingCr) {
      this.endRecord(records);
      this.pendingCr = false;
    } else if (
      this.mode !== "fieldStart" ||
      this.field.length > 0 ||
      this.fields.length > 0
    ) {
      // 末条记录无换行结尾。
      this.endRecord(records);
    }
    return records;
  }

  private endField(): void {
    this.fields.push(this.field);
    this.field = "";
  }

  private endRecord(records: string[][]): void {
    this.endField();
    records.push(this.fields);
    this.fields = [];
    this.mode = "fieldStart";
  }
}
