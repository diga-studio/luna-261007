/**
 * 增量 CSV 解析器：按任意字符串块喂入解码后的文本，
 * 产出完整逻辑记录。支持双引号字段、引号内逗号与换行、
 * 双写双引号转义、LF 与 CRLF，末条记录可无换行。
 * 解析结果与分块方式无关。
 */

const enum State {
  FieldStart,
  Unquoted,
  Quoted,
  QuoteEnd,
  CrSeen,
}

export class CsvParser {
  private state: State = State.FieldStart;
  private parts: string[] = [];
  private record: string[] = [];

  /** 喂入一段解码后的文本，返回新完成的逻辑记录。 */
  push(chunk: string): string[][] {
    const records: string[][] = [];
    let state = this.state;
    let segmentStart = 0;
    const endField = (upto: number): void => {
      if (upto > segmentStart) this.parts.push(chunk.slice(segmentStart, upto));
      this.record.push(this.parts.length === 1 ? this.parts[0]! : this.parts.join(''));
      this.parts = [];
    };
    const emitRecord = (): void => {
      records.push(this.record);
      this.record = [];
    };

    let i = 0;
    const n = chunk.length;
    while (i < n) {
      const ch = chunk.charCodeAt(i);
      switch (state) {
        case State.FieldStart:
          if (ch === 0x22 /* " */) {
            state = State.Quoted;
            segmentStart = i + 1;
          } else if (ch === 0x2c /* , */) {
            endField(i);
            segmentStart = i + 1;
          } else if (ch === 0x0a /* \n */) {
            endField(i);
            emitRecord();
            segmentStart = i + 1;
          } else if (ch === 0x0d /* \r */) {
            endField(i);
            state = State.CrSeen;
            segmentStart = i + 1;
          } else {
            state = State.Unquoted;
          }
          break;
        case State.Unquoted:
          if (ch === 0x2c) {
            endField(i);
            state = State.FieldStart;
            segmentStart = i + 1;
          } else if (ch === 0x0a) {
            endField(i);
            emitRecord();
            state = State.FieldStart;
            segmentStart = i + 1;
          } else if (ch === 0x0d) {
            endField(i);
            state = State.CrSeen;
            segmentStart = i + 1;
          }
          break;
        case State.Quoted:
          if (ch === 0x22) {
            if (i > segmentStart) this.parts.push(chunk.slice(segmentStart, i));
            state = State.QuoteEnd;
            segmentStart = i + 1;
          }
          break;
        case State.QuoteEnd:
          if (ch === 0x22) {
            // 双写双引号：还原为一个字面双引号，继续引号字段。
            this.parts.push('"');
            state = State.Quoted;
            segmentStart = i + 1;
          } else if (ch === 0x2c) {
            endField(i);
            state = State.FieldStart;
            segmentStart = i + 1;
          } else if (ch === 0x0a) {
            endField(i);
            emitRecord();
            state = State.FieldStart;
            segmentStart = i + 1;
          } else if (ch === 0x0d) {
            endField(i);
            state = State.CrSeen;
            segmentStart = i + 1;
          }
          break;
        case State.CrSeen:
          // 合法输入保证 \r 后紧跟 \n；容错处理其它字符。
          emitRecord();
          state = State.FieldStart;
          segmentStart = i;
          if (ch === 0x0a) {
            segmentStart = i + 1;
          } else {
            continue; // 不前进，按 FieldStart 重新处理当前字符
          }
          break;
      }
      i++;
    }

    // 块尾：把未完成的片段暂存（Quoted/Unquoted 状态下）。
    if (n > segmentStart && (state === State.Unquoted || state === State.Quoted)) {
      this.parts.push(chunk.slice(segmentStart));
    }
    this.state = state;
    return records;
  }

  /** 输入结束，冲刷末尾记录（若有）。 */
  end(): string[][] {
    const records: string[][] = [];
    if (this.state === State.Unquoted || this.state === State.QuoteEnd) {
      this.record.push(this.parts.length === 1 ? this.parts[0]! : this.parts.join(''));
      this.parts = [];
      records.push(this.record);
      this.record = [];
    } else if (this.state === State.CrSeen) {
      records.push(this.record);
      this.record = [];
    } else if (this.state === State.FieldStart && this.record.length > 0) {
      // 以逗号结尾的末条记录：补一个空字段。
      this.record.push('');
      records.push(this.record);
      this.record = [];
    }
    // FieldStart 且 record 为空：输入以换行结尾或为空，无残留记录。
    // Quoted：输入不合法（引号未闭合），按约定不会出现。
    this.state = State.FieldStart;
    return records;
  }
}
