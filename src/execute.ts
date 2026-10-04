import {
  GraphQLError,
  buildSchema,
  getOperationAST,
  getVariableValues,
  parse,
  validate,
  type DocumentNode,
  type ExecutionResult,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
} from "graphql";
import { buildDelegationRequest, collectNamespaceFields } from "./delegate.js";
import { buildComposedSchema, COMPOSED_QUERY_TYPE_NAME } from "./schema.js";
import { transformServiceResult } from "./transform.js";
import type { NamespaceGateway, ServiceConfig } from "./types.js";

interface ServiceState {
  config: ServiceConfig;
  originalSchema: GraphQLSchema;
}

interface FieldGroup {
  namespace: string;
  responseKey: string;
  fieldNodes: readonly FieldNode[];
}

/** 创建内存中的命名空间网关：组合 Schema、委派与结果转换全部在内存完成。 */
export function createGateway(services: ServiceConfig[]): NamespaceGateway {
  const schema = buildComposedSchema(services);
  const states = new Map<string, ServiceState>();
  for (const config of services) {
    states.set(config.namespace, {
      config,
      originalSchema: buildSchema(config.sdl),
    });
  }

  const execute = async (
    query: string | DocumentNode,
    variableValues: Record<string, unknown> = {},
    operationName?: string,
  ): Promise<ExecutionResult> => {
    let document: DocumentNode;
    try {
      document = typeof query === "string" ? parse(query) : query;
    } catch (error) {
      return { errors: [error as GraphQLError] };
    }

    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) {
      return { errors: validationErrors };
    }

    const operation = getOperationAST(document, operationName);
    if (!operation) {
      return {
        errors: [
          new GraphQLError(
            operationName
              ? `Unknown operation named "${operationName}".`
              : "Must provide operation name if query contains multiple operations.",
          ),
        ],
      };
    }

    const coerced = getVariableValues(
      schema,
      operation.variableDefinitions ?? [],
      variableValues,
    );
    if (coerced.errors) {
      return { errors: [...coerced.errors] };
    }
    const coercedVariables = coerced.coerced as Record<string, unknown>;

    const collected = collectNamespaceFields(document, operationName, coercedVariables);
    if (!collected) {
      return { errors: [new GraphQLError("Unable to collect root fields.")] };
    }
    const { groups } = collected;

    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of document.definitions) {
      if (definition.kind === "FragmentDefinition") {
        fragments.set(definition.name.value, definition);
      }
    }

    const data: Record<string, unknown> = {};
    const errors: GraphQLError[] = [];
    const seenErrors = new Set<string>();

    const runGroup = async (group: FieldGroup): Promise<void> => {
      if (group.namespace === "__typename") {
        data[group.responseKey] = COMPOSED_QUERY_TYPE_NAME;
        return;
      }
      const state = states.get(group.namespace);
      if (!state) {
        data[group.responseKey] = null;
        return;
      }
      const request = buildDelegationRequest({
        originalSchema: state.originalSchema,
        namespace: group.namespace,
        operation,
        fragments,
        fieldNodes: group.fieldNodes,
        variableValues: coercedVariables,
      });
      const upstream = await state.config.execute(request.document, request.variableValues);
      const transformed = transformServiceResult({
        originalSchema: state.originalSchema,
        namespace: group.namespace,
        document: request.document,
        typenameAlias: request.typenameAlias,
        variableValues: request.variableValues,
        result: upstream,
        responseKey: group.responseKey,
      });
      data[group.responseKey] = transformed.value;
      for (const error of transformed.errors) {
        const fingerprint = `${error.message}|${JSON.stringify(error.path ?? [])}`;
        if (!seenErrors.has(fingerprint)) {
          seenErrors.add(fingerprint);
          errors.push(error);
        }
      }
    };

    await Promise.all(groups.map(runGroup));

    const result: ExecutionResult = { data };
    if (errors.length > 0) {
      result.errors = errors;
    }
    return result;
  };

  return { schema, execute };
}
