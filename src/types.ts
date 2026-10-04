/** A JSON value as allowed inside template blocks. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A template block: arbitrary JSON object whose string leaves may contain {{token}} placeholders. */
export type TemplateBlock = { [key: string]: JsonValue };

/** Token declaration: name -> default value used when the query param is absent. */
export type TokenDeclarations = Record<string, string>;

/** Content of a single template revision. */
export interface TemplateContent {
  tokens: TokenDeclarations;
  blocks: TemplateBlock;
}

/** A stored template revision. */
export interface TemplateRevision {
  templateId: string;
  revision: number;
  content: TemplateContent;
}

/** Decoded query parameters for one page. */
export type QueryParams = Record<string, string>;

/** One page submitted to a batch. */
export interface PageInput {
  templateId: string;
  params: QueryParams;
}

/** One parsed page result, delivered in input order. */
export interface PageResult {
  sequence: number;
  templateId: string;
  revision: number;
  output: TemplateBlock;
}

export type BatchState = "active" | "completed" | "cancelled";
