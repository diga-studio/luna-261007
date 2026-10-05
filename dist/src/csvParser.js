/**
 * 增量 CSV 解析器：按任意字符串块喂入解码后的文本，
 * 产出完整逻辑记录。支持双引号字段、引号内逗号与换行、
 * 双写双引号转义、LF 与 CRLF，末条记录可无换行。
 * 解析结果与分块方式无关。
 */
export class CsvParser {
    state = 0 /* State.FieldStart */;
    parts = [];
    record = [];
    /** 喂入一段解码后的文本，返回新完成的逻辑记录。 */
    push(chunk) {
        const records = [];
        let state = this.state;
        let segmentStart = 0;
        const endField = (upto) => {
            if (upto > segmentStart)
                this.parts.push(chunk.slice(segmentStart, upto));
            this.record.push(this.parts.length === 1 ? this.parts[0] : this.parts.join(''));
            this.parts = [];
        };
        const emitRecord = () => {
            records.push(this.record);
            this.record = [];
        };
        let i = 0;
        const n = chunk.length;
        while (i < n) {
            const ch = chunk.charCodeAt(i);
            switch (state) {
                case 0 /* State.FieldStart */:
                    if (ch === 0x22 /* " */) {
                        state = 2 /* State.Quoted */;
                        segmentStart = i + 1;
                    }
                    else if (ch === 0x2c /* , */) {
                        endField(i);
                        segmentStart = i + 1;
                    }
                    else if (ch === 0x0a /* \n */) {
                        endField(i);
                        emitRecord();
                        segmentStart = i + 1;
                    }
                    else if (ch === 0x0d /* \r */) {
                        endField(i);
                        state = 4 /* State.CrSeen */;
                        segmentStart = i + 1;
                    }
                    else {
                        state = 1 /* State.Unquoted */;
                    }
                    break;
                case 1 /* State.Unquoted */:
                    if (ch === 0x2c) {
                        endField(i);
                        state = 0 /* State.FieldStart */;
                        segmentStart = i + 1;
                    }
                    else if (ch === 0x0a) {
                        endField(i);
                        emitRecord();
                        state = 0 /* State.FieldStart */;
                        segmentStart = i + 1;
                    }
                    else if (ch === 0x0d) {
                        endField(i);
                        state = 4 /* State.CrSeen */;
                        segmentStart = i + 1;
                    }
                    break;
                case 2 /* State.Quoted */:
                    if (ch === 0x22) {
                        if (i > segmentStart)
                            this.parts.push(chunk.slice(segmentStart, i));
                        state = 3 /* State.QuoteEnd */;
                        segmentStart = i + 1;
                    }
                    break;
                case 3 /* State.QuoteEnd */:
                    if (ch === 0x22) {
                        // 双写双引号：还原为一个字面双引号，继续引号字段。
                        this.parts.push('"');
                        state = 2 /* State.Quoted */;
                        segmentStart = i + 1;
                    }
                    else if (ch === 0x2c) {
                        endField(i);
                        state = 0 /* State.FieldStart */;
                        segmentStart = i + 1;
                    }
                    else if (ch === 0x0a) {
                        endField(i);
                        emitRecord();
                        state = 0 /* State.FieldStart */;
                        segmentStart = i + 1;
                    }
                    else if (ch === 0x0d) {
                        endField(i);
                        state = 4 /* State.CrSeen */;
                        segmentStart = i + 1;
                    }
                    break;
                case 4 /* State.CrSeen */:
                    // 合法输入保证 \r 后紧跟 \n；容错处理其它字符。
                    emitRecord();
                    state = 0 /* State.FieldStart */;
                    segmentStart = i;
                    if (ch === 0x0a) {
                        segmentStart = i + 1;
                    }
                    else {
                        continue; // 不前进，按 FieldStart 重新处理当前字符
                    }
                    break;
            }
            i++;
        }
        // 块尾：把未完成的片段暂存（Quoted/Unquoted 状态下）。
        if (n > segmentStart && (state === 1 /* State.Unquoted */ || state === 2 /* State.Quoted */)) {
            this.parts.push(chunk.slice(segmentStart));
        }
        this.state = state;
        return records;
    }
    /** 输入结束，冲刷末尾记录（若有）。 */
    end() {
        const records = [];
        if (this.state === 1 /* State.Unquoted */ || this.state === 3 /* State.QuoteEnd */) {
            this.record.push(this.parts.length === 1 ? this.parts[0] : this.parts.join(''));
            this.parts = [];
            records.push(this.record);
            this.record = [];
        }
        else if (this.state === 4 /* State.CrSeen */) {
            records.push(this.record);
            this.record = [];
        }
        else if (this.state === 0 /* State.FieldStart */ && this.record.length > 0) {
            // 以逗号结尾的末条记录：补一个空字段。
            this.record.push('');
            records.push(this.record);
            this.record = [];
        }
        // FieldStart 且 record 为空：输入以换行结尾或为空，无残留记录。
        // Quoted：输入不合法（引号未闭合），按约定不会出现。
        this.state = 0 /* State.FieldStart */;
        return records;
    }
}
