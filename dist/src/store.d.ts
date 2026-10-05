import type { WordEntry } from "./types.js";
/** SQLite 词表存储：全量替换 + 读取，重新打开库后仍可用 */
export declare class WordStore {
    private readonly db;
    constructor(dbPath: string);
    replaceAll(entries: WordEntry[]): void;
    getAll(): WordEntry[];
    close(): void;
}
