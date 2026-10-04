import type { DocumentNode, GraphQLSchema } from "graphql";

export interface DelegatedExecutionResult {
  data?: Record<string, unknown> | null;
  errors?: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<string | number> | null;
    extensions?: Record<string, unknown>;
  }>;
}

export type ServiceExecutor = (
  document: DocumentNode,
  variables: Record<string, unknown>,
) => DelegatedExecutionResult | Promise<DelegatedExecutionResult>;

export interface ServiceConfig {
  namespace: string;
  sdl: string;
  execute: ServiceExecutor;
}

export interface GatewayExecutionResult {
  data?: Record<string, unknown> | null;
  errors?: ReadonlyArray<{
    message: string;
    path?: ReadonlyArray<string | number> | null;
    extensions?: Record<string, unknown>;
  }>;
}

export interface NamespaceGateway {
  readonly schema: GraphQLSchema;
  execute(
    query: string | DocumentNode,
    variables?: Record<string, unknown>,
    operationName?: string,
  ): Promise<GatewayExecutionResult>;
}
