import { importCsv } from '../src/index.js';
/** 把字节串按固定块大小切成异步流。 */
export async function* chunkBytes(data, size) {
    for (let i = 0; i < data.length; i += size) {
        yield data.subarray(i, Math.min(i + size, data.length));
    }
}
export async function collect(events) {
    const out = [];
    for await (const e of events)
        out.push(e);
    return out;
}
/** 以指定字节块大小跑完整导入，返回全部事件。 */
export async function runImport(csv, chunkSize) {
    return collect(importCsv(chunkBytes(new TextEncoder().encode(csv), chunkSize)));
}
export function metaOf(events) {
    const meta = events.find((e) => e.kind === 'meta');
    if (!meta)
        throw new Error('missing meta event');
    return meta;
}
export function recordsOf(events) {
    return events.filter((e) => e.kind === 'record');
}
/** 生成 n 条数据记录的 CSV（header + n 行），每行 cols 列。 */
export function makeCsv(header, rows, newline = '\n') {
    const q = (s) => /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    const lines = [header, ...rows].map((r) => r.map(q).join(','));
    return lines.join(newline) + newline;
}
