import {
  doTypesOverlap,
  getNamedType,
  isAbstractType,
  isCompositeType,
  isInterfaceType,
  isObjectType,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLField,
  type GraphQLSchema,
  type SelectionSetNode,
  Kind,
} from "graphql";
import type { DelegatedExecutionResult } from "./types.js";

export interface RewriteArgs {
  schema: GraphQLSchema;
  namespace: string;
  document: DocumentNode;
  data: Record<string, unknown>;
  injectedTypenameAlias: string | null;
}

interface Ctx {
  schema: GraphQLSchema;
  namespace: string;
  fragments: Map<string, FragmentDefinitionNode>;
  injectedTypenameAlias: string | null;
}

function fieldDefOf(
  parentType: GraphQLCompositeType,
  fieldName: string,
): GraphQLField<unknown, unknown> | undefined {
  if (isObjectType(parentType) || isInterfaceType(parentType)) {
    return parentType.getFields()[fieldName];
  }
  return undefined;
}

function typenameKeyOf(set: SelectionSetNode, ctx: Ctx): string | null {
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD && sel.name.value === "__typename") {
      return sel.alias?.value ?? sel.name.value;
    }
  }
  return ctx.injectedTypenameAlias;
}

function rewriteValue(
  value: unknown,
  set: SelectionSetNode,
  parentType: GraphQLCompositeType,
  ctx: Ctx,
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) rewriteValue(item, set, parentType, ctx);
    return;
  }
  if (typeof value !== "object") return;
  rewriteObject(value as Record<string, unknown>, set, parentType, ctx);
}

function rewriteObject(
  data: Record<string, unknown>,
  set: SelectionSetNode,
  parentType: GraphQLCompositeType,
  ctx: Ctx,
): void {
  let concreteType: GraphQLCompositeType = parentType;
  if (isAbstractType(parentType)) {
    const key = typenameKeyOf(set, ctx);
    const typename = key ? data[key] : undefined;
    if (typeof typename === "string") {
      const t = ctx.schema.getType(typename);
      if (t && isCompositeType(t)) concreteType = t;
    }
  }

  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      const key = sel.alias?.value ?? sel.name.value;
      if (!(key in data)) continue;
      if (sel.name.value === "__typename") {
        const v = data[key];
        if (typeof v === "string") {
          data[key] = `${ctx.namespace}_${v}`;
        }
        continue;
      }
      const def = fieldDefOf(concreteType, sel.name.value);
      if (!def || !sel.selectionSet) continue;
      const named = getNamedType(def.type);
      if (isCompositeType(named)) {
        rewriteValue(data[key], sel.selectionSet, named, ctx);
      }
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      const condition = sel.typeCondition;
      if (condition) {
        const t = ctx.schema.getType(condition.name.value);
        if (!t || !isCompositeType(t)) continue;
        if (!doTypesOverlap(ctx.schema, t, concreteType)) continue;
        rewriteObject(data, sel.selectionSet, t, ctx);
      } else {
        rewriteObject(data, sel.selectionSet, concreteType, ctx);
      }
    } else {
      const frag = ctx.fragments.get(sel.name.value);
      if (!frag) continue;
      const t = ctx.schema.getType(frag.typeCondition.name.value);
      if (!t || !isCompositeType(t)) continue;
      if (!doTypesOverlap(ctx.schema, t, concreteType)) continue;
      rewriteObject(data, frag.selectionSet, t, ctx);
    }
  }

  if (ctx.injectedTypenameAlias && ctx.injectedTypenameAlias in data) {
    delete data[ctx.injectedTypenameAlias];
  }
}

export function rewriteDelegatedData(args: RewriteArgs): Record<string, unknown> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  let operationSet: SelectionSetNode | null = null;
  for (const def of args.document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(def.name.value, def);
    } else if (def.kind === Kind.OPERATION_DEFINITION) {
      operationSet = def.selectionSet;
    }
  }
  if (!operationSet) throw new Error("delegated document has no operation");
  const queryType = args.schema.getQueryType();
  if (!queryType) throw new Error("schema has no query type");
  const ctx: Ctx = {
    schema: args.schema,
    namespace: args.namespace,
    fragments,
    injectedTypenameAlias: args.injectedTypenameAlias,
  };
  rewriteObject(args.data, operationSet, queryType, ctx);
  return args.data;
}

export interface MappedError {
  message: string;
  path: Array<string | number>;
  extensions?: Record<string, unknown>;
}

export function mapDelegatedErrors(
  errors: DelegatedExecutionResult["errors"],
  responseKey: string,
): MappedError[] {
  if (!errors) return [];
  return errors.map((e) => {
    const mapped: MappedError = {
      message: e.message,
      path: [responseKey, ...(e.path ?? [])],
    };
    if (e.extensions !== undefined) mapped.extensions = e.extensions;
    return mapped;
  });
}
