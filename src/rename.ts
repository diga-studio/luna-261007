import {
  buildASTSchema,
  parse,
  visit,
  type DefinitionNode,
  type DocumentNode,
  type GraphQLSchema,
  type NamedTypeNode,
  type NameNode,
  Kind,
} from "graphql";
import type { ServiceConfig } from "./types.js";

const BUILTIN_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

const TYPE_DEF_KINDS: ReadonlySet<string> = new Set([
  Kind.OBJECT_TYPE_DEFINITION,
  Kind.INTERFACE_TYPE_DEFINITION,
  Kind.UNION_TYPE_DEFINITION,
  Kind.ENUM_TYPE_DEFINITION,
  Kind.INPUT_OBJECT_TYPE_DEFINITION,
]);

export interface RenamedService {
  namespace: string;
  schema: GraphQLSchema;
  queryRootName: string;
  composedQueryRootName: string;
  toComposedName(original: string): string;
  toOriginalName(composed: string): string;
}

export interface ComposedSchema {
  schema: GraphQLSchema;
  services: ReadonlyMap<string, RenamedService>;
  fieldToNamespace: ReadonlyMap<string, string>;
}

function findQueryRootName(doc: DocumentNode): string {
  for (const def of doc.definitions) {
    if (def.kind === Kind.SCHEMA_DEFINITION || def.kind === Kind.SCHEMA_EXTENSION) {
      for (const op of def.operationTypes ?? []) {
        if (op.operation === "query") return op.type.name.value;
      }
    }
  }
  return "Query";
}

export function renameDocument(
  doc: DocumentNode,
  namespace: string,
): { doc: DocumentNode; queryRootName: string } {
  const queryRootName = findQueryRootName(doc);
  const localNames = new Set<string>();
  for (const def of doc.definitions) {
    if (TYPE_DEF_KINDS.has(def.kind)) {
      localNames.add((def as { name: NameNode }).name.value);
    }
  }
  const rename = (name: string): string =>
    localNames.has(name) && !BUILTIN_SCALARS.has(name) ? `${namespace}_${name}` : name;

  const renamed = visit(doc, {
    [Kind.SCHEMA_DEFINITION]: () => null,
    [Kind.SCHEMA_EXTENSION]: () => null,
    [Kind.NAME](node, _key, parent) {
      if (
        parent &&
        !Array.isArray(parent) &&
        (parent as { kind: string }).kind === Kind.NAMED_TYPE
      ) {
        return { ...node, value: rename(node.value) };
      }
      if (
        parent &&
        !Array.isArray(parent) &&
        TYPE_DEF_KINDS.has((parent as { kind: string }).kind) &&
        (parent as { name?: NameNode }).name === node
      ) {
        return { ...node, value: rename(node.value) };
      }
      return undefined;
    },
  });
  return { doc: renamed, queryRootName };
}

export function buildComposedSchema(
  services: ReadonlyArray<ServiceConfig>,
): ComposedSchema {
  const seenNamespaces = new Set<string>();
  const renamedServices = new Map<string, RenamedService>();
  const fieldToNamespace = new Map<string, string>();
  const allDefs: DefinitionNode[] = [];
  const rootFields: string[] = [];

  for (const service of services) {
    if (seenNamespaces.has(service.namespace)) {
      throw new Error(`duplicate namespace: ${service.namespace}`);
    }
    seenNamespaces.add(service.namespace);

    const originalDoc = parse(service.sdl);
    const originalSchema = buildASTSchema(originalDoc);
    if (originalSchema.getMutationType() || originalSchema.getSubscriptionType()) {
      throw new Error(
        `service ${service.namespace}: only query operations are supported`,
      );
    }

    const { doc: renamedDoc, queryRootName } = renameDocument(
      originalDoc,
      service.namespace,
    );
    const composedQueryRootName = `${service.namespace}_${queryRootName}`;

    allDefs.push(...renamedDoc.definitions);
    rootFields.push(`${service.namespace}: ${composedQueryRootName}`);
    fieldToNamespace.set(service.namespace, service.namespace);

    renamedServices.set(service.namespace, {
      namespace: service.namespace,
      schema: originalSchema,
      queryRootName,
      composedQueryRootName,
      toComposedName: (original) =>
        BUILTIN_SCALARS.has(original) ? original : `${service.namespace}_${original}`,
      toOriginalName: (composed) =>
        composed.startsWith(`${service.namespace}_`) &&
        !BUILTIN_SCALARS.has(composed)
          ? composed.slice(service.namespace.length + 1)
          : composed,
    });
  }

  const composedDoc = parse(
    `type Query {\n  ${rootFields.join("\n  ")}\n}`,
  );
  const combined: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [...composedDoc.definitions, ...allDefs],
  };

  return {
    schema: buildASTSchema(combined),
    services: renamedServices,
    fieldToNamespace,
  };
}
