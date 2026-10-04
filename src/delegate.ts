import {
  getDirectiveValues,
  getNamedType,
  getOperationAST,
  isAbstractType,
  isCompositeType,
  isObjectType,
  isInterfaceType,
  validate,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLField,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type TypeNode,
  type VariableDefinitionNode,
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
  OperationTypeNode,
} from "graphql";
import type { RenamedService } from "./rename.js";

export interface RootFieldGroup {
  responseKey: string;
  fieldName: string;
  nodes: FieldNode[];
}

export interface DelegationRequest {
  namespace: string;
  responseKey: string;
  document: DocumentNode;
  variables: Record<string, unknown>;
  injectedTypenameAlias: string | null;
}

const INJECTED_BASE = "__ns_typename";

function shouldInclude(
  node: { directives?: readonly unknown[] },
  variableValues: Record<string, unknown>,
): boolean {
  const skip = getDirectiveValues(
    GraphQLSkipDirective,
    node as Parameters<typeof getDirectiveValues>[1],
    variableValues,
  );
  if (skip?.if === true) return false;
  const include = getDirectiveValues(
    GraphQLIncludeDirective,
    node as Parameters<typeof getDirectiveValues>[1],
    variableValues,
  );
  if (include?.if === false) return false;
  return true;
}

export function collectRootFieldGroups(
  operation: OperationDefinitionNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  variableValues: Record<string, unknown>,
): RootFieldGroup[] {
  const groups = new Map<string, RootFieldGroup>();
  const visitSet = (set: SelectionSetNode): void => {
    for (const sel of set.selections) {
      if (!shouldInclude(sel, variableValues)) continue;
      if (sel.kind === Kind.FIELD) {
        const key = sel.alias?.value ?? sel.name.value;
        let group = groups.get(key);
        if (!group) {
          group = { responseKey: key, fieldName: sel.name.value, nodes: [] };
          groups.set(key, group);
        }
        group.nodes.push(sel);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        visitSet(sel.selectionSet);
      } else {
        const frag = fragments.get(sel.name.value);
        if (frag) visitSet(frag.selectionSet);
      }
    }
  };
  visitSet(operation.selectionSet);
  return [...groups.values()];
}

function collectUsedVariables(
  selections: readonly SelectionNode[],
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  used: Set<string>,
  seenFragments: Set<string>,
): void {
  for (const sel of selections) {
    if (sel.kind === Kind.FIELD || sel.kind === Kind.INLINE_FRAGMENT) {
      for (const dir of sel.directives ?? []) {
        for (const arg of dir.arguments ?? []) {
          if (arg.value.kind === Kind.VARIABLE) used.add(arg.value.name.value);
        }
      }
    }
    if (sel.kind === Kind.FIELD) {
      for (const arg of sel.arguments ?? []) {
        const walk = (v: typeof arg.value): void => {
          if (v.kind === Kind.VARIABLE) used.add(v.name.value);
          else if (v.kind === Kind.LIST) v.values.forEach(walk);
          else if (v.kind === Kind.OBJECT) v.fields.forEach((f) => walk(f.value));
        };
        walk(arg.value);
      }
      if (sel.selectionSet) {
        collectUsedVariables(sel.selectionSet.selections, fragments, used, seenFragments);
      }
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      collectUsedVariables(sel.selectionSet.selections, fragments, used, seenFragments);
    } else {
      if (!seenFragments.has(sel.name.value)) {
        seenFragments.add(sel.name.value);
        const frag = fragments.get(sel.name.value);
        if (frag) {
          collectUsedVariables(frag.selectionSet.selections, fragments, used, seenFragments);
        }
      }
    }
  }
}

function renameTypeNode(node: TypeNode, toOriginal: (n: string) => string): TypeNode {
  switch (node.kind) {
    case Kind.NAMED_TYPE:
      return { ...node, name: { ...node.name, value: toOriginal(node.name.value) } };
    case Kind.LIST_TYPE:
      return { ...node, type: renameTypeNode(node.type, toOriginal) };
    case Kind.NON_NULL_TYPE:
      return {
        ...node,
        type: renameTypeNode(node.type, toOriginal) as
          | import("graphql").NamedTypeNode
          | import("graphql").ListTypeNode,
      };
  }
}

interface TransformContext {
  service: RenamedService;
  composedFragments: ReadonlyMap<string, FragmentDefinitionNode>;
  emittedFragments: Map<string, FragmentDefinitionNode>;
  injectedAlias: string | null;
  usedResponseKeys: Set<string>;
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

function pickInjectedAlias(ctx: TransformContext): string {
  if (ctx.injectedAlias) return ctx.injectedAlias;
  let candidate = INJECTED_BASE;
  let i = 0;
  while (ctx.usedResponseKeys.has(candidate)) {
    i += 1;
    candidate = `${INJECTED_BASE}_${i}`;
  }
  ctx.injectedAlias = candidate;
  return candidate;
}

function transformSelectionSet(
  set: SelectionSetNode,
  parentType: GraphQLCompositeType,
  ctx: TransformContext,
): SelectionSetNode {
  const hasTypename = set.selections.some(
    (s) => s.kind === Kind.FIELD && s.name.value === "__typename",
  );
  const selections: SelectionNode[] = [];
  if (!hasTypename && isAbstractType(parentType)) {
    const alias = pickInjectedAlias(ctx);
    selections.push({
      kind: Kind.FIELD,
      name: { kind: Kind.NAME, value: "__typename" },
      alias: { kind: Kind.NAME, value: alias },
    });
  }
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      let selectionSet: SelectionSetNode | undefined;
      if (sel.selectionSet) {
        const def = fieldDefOf(parentType, sel.name.value);
        if (!def) {
          throw new Error(`unknown field ${sel.name.value} on ${parentType.name}`);
        }
        const named = getNamedType(def.type);
        if (!isCompositeType(named)) {
          throw new Error(`field ${sel.name.value} is not composite`);
        }
        selectionSet = transformSelectionSet(sel.selectionSet, named, ctx);
      }
      selections.push(
        selectionSet ? { ...sel, selectionSet } : sel,
      );
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      const condition = sel.typeCondition;
      let nextParent: GraphQLCompositeType = parentType;
      let typeCondition;
      if (condition) {
        const originalName = ctx.service.toOriginalName(condition.name.value);
        const t = ctx.service.schema.getType(originalName);
        if (!t || !isCompositeType(t)) {
          throw new Error(`unknown type condition ${condition.name.value}`);
        }
        nextParent = t;
        typeCondition = {
          ...condition,
          name: { ...condition.name, value: originalName },
        };
      }
      selections.push({
        ...sel,
        ...(typeCondition ? { typeCondition } : {}),
        selectionSet: transformSelectionSet(sel.selectionSet, nextParent, ctx),
      });
    } else {
      selections.push(sel);
      emitFragment(sel.name.value, ctx);
    }
  }
  return { ...set, selections };
}

function emitFragment(name: string, ctx: TransformContext): void {
  if (ctx.emittedFragments.has(name)) return;
  const frag = ctx.composedFragments.get(name);
  if (!frag) throw new Error(`unknown fragment ${name}`);
  ctx.emittedFragments.set(name, frag);
  const originalName = ctx.service.toOriginalName(frag.typeCondition.name.value);
  const t = ctx.service.schema.getType(originalName);
  if (!t || !isCompositeType(t)) {
    throw new Error(`unknown fragment type ${frag.typeCondition.name.value}`);
  }
  const transformed: FragmentDefinitionNode = {
    ...frag,
    typeCondition: {
      ...frag.typeCondition,
      name: { ...frag.typeCondition.name, value: originalName },
    },
    selectionSet: transformSelectionSet(frag.selectionSet, t, ctx),
  };
  ctx.emittedFragments.set(name, transformed);
}

function gatherResponseKeys(set: SelectionSetNode, out: Set<string>): void {
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      out.add(sel.alias?.value ?? sel.name.value);
      if (sel.selectionSet) gatherResponseKeys(sel.selectionSet, out);
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      gatherResponseKeys(sel.selectionSet, out);
    }
  }
}

export interface BuildDelegationsArgs {
  document: DocumentNode;
  operationName?: string | undefined;
  variableValues: Record<string, unknown>;
  groups: ReadonlyArray<RootFieldGroup>;
  services: ReadonlyMap<string, RenamedService>;
  fieldToNamespace: ReadonlyMap<string, string>;
}

export function buildDelegations(args: BuildDelegationsArgs): DelegationRequest[] {
  const operation = getOperationAST(args.document, args.operationName ?? null);
  if (!operation) throw new Error("operation not found");
  const composedFragments = new Map<string, FragmentDefinitionNode>();
  for (const def of args.document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) composedFragments.set(def.name.value, def);
  }

  const requests: DelegationRequest[] = [];
  for (const group of args.groups) {
    if (group.fieldName === "__typename") continue;
    const namespace = args.fieldToNamespace.get(group.fieldName);
    if (!namespace) throw new Error(`unknown root field ${group.fieldName}`);
    const service = args.services.get(namespace);
    if (!service) throw new Error(`unknown namespace ${namespace}`);
    const queryType = service.schema.getQueryType();
    if (!queryType) throw new Error(`service ${namespace} has no query type`);

    const merged: SelectionSetNode = {
      kind: Kind.SELECTION_SET,
      selections: group.nodes.flatMap((n) =>
        n.selectionSet ? [...n.selectionSet.selections] : [],
      ),
    };
    const usedResponseKeys = new Set<string>();
    gatherResponseKeys(merged, usedResponseKeys);

    const ctx: TransformContext = {
      service,
      composedFragments,
      emittedFragments: new Map(),
      injectedAlias: null,
      usedResponseKeys,
    };
    const selectionSet = transformSelectionSet(merged, queryType, ctx);

    const usedVars = new Set<string>();
    const emittedList = [...ctx.emittedFragments.values()];
    collectUsedVariables(selectionSet.selections, new Map(emittedList.map((f) => [f.name.value, f])), usedVars, new Set());

    const variableDefinitions: VariableDefinitionNode[] = (
      operation.variableDefinitions ?? []
    )
      .filter((vd) => usedVars.has(vd.variable.name.value))
      .map((vd) => ({
        ...vd,
        type: renameTypeNode(vd.type, (n) => service.toOriginalName(n)),
      }));

    const delegatedOp: OperationDefinitionNode = {
      kind: Kind.OPERATION_DEFINITION,
      operation: OperationTypeNode.QUERY,
      selectionSet,
      variableDefinitions,
    };
    const document: DocumentNode = {
      kind: Kind.DOCUMENT,
      definitions: [delegatedOp, ...emittedList],
    };

    const errors = validate(service.schema, document);
    if (errors.length > 0) {
      throw new Error(
        `invalid delegated document for ${namespace}: ${errors.map((e) => e.message).join("; ")}`,
      );
    }

    const variables: Record<string, unknown> = {};
    for (const name of usedVars) {
      if (name in args.variableValues) variables[name] = args.variableValues[name];
    }

    requests.push({
      namespace,
      responseKey: group.responseKey,
      document,
      variables,
      injectedTypenameAlias: ctx.injectedAlias,
    });
  }
  return requests;
}
