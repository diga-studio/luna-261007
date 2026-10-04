import type { DocumentNode, ExecutionResult, GraphQLSchema } from "graphql";

/** 调用方提供的进程内执行回调：接收原始服务的 GraphQL 文档与变量，返回标准执行结果。 */
export type ServiceExecutor = (
  document: DocumentNode,
  variableValues: Record<string, unknown>,
) => Promise<ExecutionResult> | ExecutionResult;

/** 单个内部服务的注册配置。 */
export interface ServiceConfig {
  /** 唯一命名空间，同时作为组合 Schema 中 Query 的字段名与类型名前缀。 */
  namespace: string;
  /** 原始服务的 SDL（只含查询）。 */
  sdl: string;
  /** 进程内执行回调。 */
  execute: ServiceExecutor;
}

/** 库对外的门面：持有组合 Schema 与各服务的内存执行状态。 */
export interface NamespaceGateway {
  /** 组合后的 Schema（Query 为根，每个命名空间一个可空字段）。 */
  readonly schema: GraphQLSchema;
  /** 执行符合组合 Schema 的查询。 */
  execute(
    query: string | DocumentNode,
    variableValues?: Record<string, unknown>,
    operationName?: string,
  ): Promise<ExecutionResult>;
}
