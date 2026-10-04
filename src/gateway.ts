import {
  getOperationAST,
  getVariableValues,
  parse,
  validate,
  type DocumentNode,
  type FragmentDefinitionNode,
  Kind,
} from "graphql";
import { buildComposedSchema } from "./rename.js";
import { buildDelegations, collectRootFieldGroups } from "./delegate.js";
import { mapDelegatedErrors, rewriteDelegatedData, type MappedError } from "./result.js";
import type {
  GatewayExecutionResult,
  NamespaceGateway,
  ServiceConfig,
} from "./types.js";

export function createNamespaceGateway(
  services: ReadonlyArray<ServiceConfig>,
): NamespaceGateway {
  const composed = buildComposedSchema(services);
  const executors = new Map(services.map((s) => [s.namespace, s.execute]));

  async function execute(
    query: string | DocumentNode,
    rawVariables?: Record<string, unknown>,
    operationName?: string,
  ): Promise<GatewayExecutionResult> {
    let document: DocumentNode;
    try {
      document = typeof query === "string" ? parse(query) : query;
    } catch (e) {
      return { errors: [{ message: (e as Error).message }] };
    }

    const validationErrors = validate(composed.schema, document);
    if (validationErrors.length > 0) {
      return { errors: validationErrors.map((e) => ({ message: e.message })) };
    }

    const operation = getOperationAST(document, operationName ?? null);
    if (!operation) {
      return { errors: [{ message: "operation not found" }] };
    }

    const coerced = getVariableValues(
      composed.schema,
      operation.variableDefinitions ?? [],
      rawVariables ?? {},
    );
    if ("errors" in coerced) {
      return { errors: coerced.errors.map((e) => ({ message: e.message })) };
    }
    const variableValues = coerced.coerced as Record<string, unknown>;

    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of document.definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    }
    const groups = collectRootFieldGroups(operation, fragments, variableValues);

    const requests = buildDelegations({
      document,
      operationName: operationName ?? undefined,
      variableValues,
      groups,
      services: composed.services,
      fieldToNamespace: composed.fieldToNamespace,
    });

    const settled = await Promise.all(
      requests.map(async (req) => {
        const executor = executors.get(req.namespace);
        if (!executor) throw new Error(`no executor for ${req.namespace}`);
        try {
          return { req, result: await executor(req.document, req.variables) };
        } catch (e) {
          return { req, thrown: e as Error };
        }
      }),
    );

    const data: Record<string, unknown> = {};
    const errors: MappedError[] = [];
    const seenErrors = new Set<string>();

    const pushErrors = (list: ReadonlyArray<MappedError>): void => {
      for (const err of list) {
        const sig = `${err.message}${JSON.stringify(err.path)}`;
        if (seenErrors.has(sig)) continue;
        seenErrors.add(sig);
        errors.push(err);
      }
    };

    const requestByKey = new Map(requests.map((r, i) => [r.responseKey, i]));
    for (const group of groups) {
      if (group.fieldName === "__typename") {
        data[group.responseKey] = "Query";
        continue;
      }
      const idx = requestByKey.get(group.responseKey);
      if (idx === undefined) continue;
      const outcome = settled[idx];
      if (!outcome) continue;
      const { req } = outcome;
      if ("thrown" in outcome && outcome.thrown) {
        data[group.responseKey] = null;
        pushErrors([{ message: outcome.thrown.message, path: [group.responseKey] }]);
        continue;
      }
      const result = outcome.result;
      if (!result) {
        data[group.responseKey] = null;
        continue;
      }
      const service = composed.services.get(req.namespace);
      if (result.data != null && service) {
        data[group.responseKey] = rewriteDelegatedData({
          schema: service.schema,
          namespace: req.namespace,
          document: req.document,
          data: result.data as Record<string, unknown>,
          injectedTypenameAlias: req.injectedTypenameAlias,
        });
      } else {
        data[group.responseKey] = null;
      }
      pushErrors(mapDelegatedErrors(result.errors, group.responseKey));
    }

    const out: GatewayExecutionResult = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  }

  return { schema: composed.schema, execute };
}
