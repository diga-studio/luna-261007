/** JSON 值类型 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 模板：JSON 区块 + 带默认值的 token 声明 */
export interface Template {
  blocks: JsonValue;
  tokens: Record<string, { default: string }>;
}

/** 一次模板修订（整体生效） */
export interface TemplateRevision {
  templateId: string;
  revision: number;
  template: Template;
}

/** 已解码的查询参数映射 */
export type QueryParams = Record<string, string>;

/** 页面输入 */
export interface PageInput {
  templateId: string;
  params: QueryParams;
}

/** 页面解析结果，按输入顺序交付 */
export interface PageResult {
  sequence: number;
  templateId: string;
  revision: number;
  output: JsonValue;
}

/** 批次句柄 */
export interface Batch {
  readonly id: string;
  /** 逐条异步提供页面输入 */
  submitPage(page: PageInput): void;
  /** 标记输入结束；全部结果交付后批次完成 */
  endInput(): void;
  /** 取消批次；返回的 promise 解决后不再交付任何结果 */
  cancel(): Promise<void>;
  /** 按输入顺序逐条交付结果 */
  results: AsyncIterable<PageResult>;
}
