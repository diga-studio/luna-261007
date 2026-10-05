// sql.js 最小类型声明（避免依赖 @types/sql.js）。
declare module 'sql.js' {
  export interface SqlJsConfig {
    locateFile?: (file: string) => string;
  }
  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }
  export interface Statement {
    bind(params?: unknown[] | Record<string, unknown>): boolean;
    step(): boolean;
    get(): unknown[];
    getAsObject(): Record<string, unknown>;
    run(params?: unknown[] | Record<string, unknown>): void;
    free(): boolean;
  }
  export interface Database {
    run(sql: string, params?: unknown[] | Record<string, unknown>): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }
  export default function initSqlJs(config?: SqlJsConfig): Promise<SqlJsStatic>;
}
