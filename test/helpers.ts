import {
  execute,
  parse,
  isAbstractType,
  type DocumentNode,
  type GraphQLSchema,
} from "graphql";
import type { DelegatedExecutionResult, ServiceExecutor } from "../src/index.js";

export interface UpstreamCall {
  document: DocumentNode;
  variables: Record<string, unknown>;
}

export interface Upstream {
  execute: ServiceExecutor;
  calls: UpstreamCall[];
}

export function attachRuntimeTypeResolution(schema: GraphQLSchema): void {
  for (const type of Object.values(schema.getTypeMap())) {
    if (isAbstractType(type) && !type.name.startsWith("__")) {
      type.resolveType = (value: unknown) =>
        (value as { __typename?: string }).__typename ?? undefined;
    }
  }
}

export function makeUpstream(
  schema: GraphQLSchema,
  rootValue: unknown,
): Upstream {
  attachRuntimeTypeResolution(schema);
  const calls: UpstreamCall[] = [];
  return {
    calls,
    execute: async (document, variables) => {
      calls.push({ document, variables });
      const result = await execute({
        schema,
        document,
        rootValue,
        variableValues: variables,
      });
      const out: DelegatedExecutionResult = {};
      if (result.data !== undefined) {
        out.data = result.data as Record<string, unknown> | null;
      }
      if (result.errors) {
        out.errors = result.errors.map((e) => ({
          message: e.message,
          path: e.path ?? null,
          ...(e.extensions ? { extensions: e.extensions as Record<string, unknown> } : {}),
        }));
      }
      return out;
    },
  };
}

export interface ReferenceResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string; path: ReadonlyArray<string | number> | null }>;
}

export async function referenceExecute(
  composedSchema: GraphQLSchema,
  namespaceData: Record<string, unknown>,
  query: string,
  variables?: Record<string, unknown>,
): Promise<ReferenceResult> {
  for (const type of Object.values(composedSchema.getTypeMap())) {
    if (isAbstractType(type) && !type.name.startsWith("__")) {
      type.resolveType = (value: unknown) => {
        const typename = (value as { __typename?: string }).__typename;
        if (!typename) return undefined;
        const match = Object.keys(namespaceData).find((ns) =>
          type.name.startsWith(`${ns}_`),
        );
        return match ? `${match}_${typename}` : undefined;
      };
    }
  }
  const rootValue: Record<string, unknown> = {};
  for (const [ns, data] of Object.entries(namespaceData)) {
    rootValue[ns] = () => data;
  }
  const result = await execute({
    schema: composedSchema,
    document: parse(query),
    rootValue,
    variableValues: variables ?? {},
  });
  const out: ReferenceResult = {};
  if (result.data !== undefined) {
    out.data = result.data as Record<string, unknown> | null;
  }
  if (result.errors) {
    out.errors = result.errors.map((e) => ({ message: e.message, path: e.path ?? null }));
  }
  return out;
}

