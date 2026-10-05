/**
 * 增量 CSV 解析器：按任意字符串块喂入解码后的文本，
 * 产出完整逻辑记录。支持双引号字段、引号内逗号与换行、
 * 双写双引号转义、LF 与 CRLF，末条记录可无换行。
 * 解析结果与分块方式无关。
 */
export declare class CsvParser {
    private state;
    private parts;
    private record;
    /** 喂入一段解码后的文本，返回新完成的逻辑记录。 */
    push(chunk: string): string[][];
    /** 输入结束，冲刷末尾记录（若有）。 */
    end(): string[][];
}
