import {
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
  OperationTypeNode,
  getDirectiveValues,
  getOperationAST,
  specifiedRules,
  validate,
  type DefinitionNode,
  type DirectiveNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type FragmentSpreadNode,
  type GraphQLSchema,
  type InlineFragmentNode,
  type NamedTypeNode,
  type OperationDefinitionNode,
  type SelectionNode,
  type SelectionSetNode,
  type TypeNode,
  type ValueNode,
  type VariableDefinitionNode,
} from "graphql";

export interface DelegationRequest {
  /** 面向原始 Schema 的委派文档（已注入 __typename 别名）。 */
  document: DocumentNode;
  /** 传给上游的变量子集（已按组合操作定义合并默认值）。 */
  variableValues: Record<string, unknown>;
  /** 注入的 __typename 别名，结果转换时需要识别并移除。 */
  typenameAlias: string;
}

export interface NamespaceFieldGroup {
  namespace: string;
  responseKey: string;
  fieldNodes: FieldNode[];
}

const TYPENAME_ALIAS_BASE = "__nsDelegateTypename";

/** 组合类型名还原为原始类型名：仅当带有该命名空间前缀时剥离。 */
function originalTypeName(namespace: string, typeName: string): string {
  const prefix = `${namespace}_`;
  return typeName.startsWith(prefix) ? typeName.slice(prefix.length) : typeName;
}

function renameTypeNodeBack(node: TypeNode, namespace: string): TypeNode {
  switch (node.kind) {
    case "NamedType":
      return { ...node, name: { ...node.name, value: originalTypeName(namespace, node.name.value) } };
    case "ListType":
      return { ...node, type: renameTypeNodeBack(node.type, namespace) };
    case "NonNullType":
      return { ...node, type: renameTypeNodeBack(node.type, namespace) as NamedTypeNode | import("graphql").ListTypeNode };
    default:
      throw new Error("Unknown type node kind");
  }
}

function shouldIncludeNode(
  node: { directives?: readonly DirectiveNode[] },
  variableValues: Record<string, unknown>,
): boolean {
  const skip = getDirectiveValues(GraphQLSkipDirective, node, variableValues);
  if (skip?.if === true) {
    return false;
  }
  const include = getDirectiveValues(GraphQLIncludeDirective, node, variableValues);
  if (include?.if === false) {
    return false;
  }
  return true;
}

/**
 * 收集组合查询某操作顶层（Query 根下）按响应键分组的字段，
 * 展开命名片段并应用 @skip/@include。被跳过的响应键不会出现。
 */
export function collectNamespaceFields(
  document: DocumentNode,
  operationName: string | undefined,
  variableValues: Record<string, unknown>,
): { operation: OperationDefinitionNode; groups: NamespaceFieldGroup[] } | null {
  const operation = getOperationAST(document, operationName);
  if (!operation) {
    return null;
  }
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === "FragmentDefinition") {
      fragments.set(definition.name.value, definition);
    }
  }
  const byKey = new Map<string, FieldNode[]>();
  const visit = (selectionSet: SelectionSetNode): void => {
    for (const selection of selectionSet.selections) {
      if (!shouldIncludeNode(selection, variableValues)) {
        continue;
      }
      if (selection.kind === "Field") {
        const key = selection.alias?.value ?? selection.name.value;
        const list = byKey.get(key);
        if (list) {
          list.push(selection);
        } else {
          byKey.set(key, [selection]);
        }
      } else if (selection.kind === "InlineFragment") {
        if (!selection.typeCondition || selection.typeCondition.name.value === "Query") {
          visit(selection.selectionSet);
        }
      } else {
        const fragment = fragments.get(selection.name.value);
        if (fragment && fragment.typeCondition.name.value === "Query") {
          visit(fragment.selectionSet);
        }
      }
    }
  };
  visit(operation.selectionSet);

  const groups: NamespaceFieldGroup[] = [];
  for (const [responseKey, fieldNodes] of byKey) {
    groups.push({ namespace: fieldNodes[0].name.value, responseKey, fieldNodes });
  }
  return { operation, groups };
}

/** 收集选择集（含可达片段）中实际用到的变量名。 */
function collectUsedVariables(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): Set<string> {
  const used = new Set<string>();
  const visitedFragments = new Set<string>();
  const visitValue = (value: ValueNode): void => {
    if (value.kind === "Variable") {
      used.add(value.name.value);
    } else if (value.kind === "ListValue") {
      value.values.forEach(visitValue);
    } else if (value.kind === "ObjectValue") {
      value.fields.forEach((field) => visitValue(field.value));
    }
  };
  const visitSelectionSet = (set: SelectionSetNode): void => {
    for (const selection of set.selections) {
      selection.directives?.forEach((directive) =>
        directive.arguments?.forEach((arg) => visitValue(arg.value)),
      );
      if (selection.kind === "Field") {
        selection.arguments?.forEach((arg) => visitValue(arg.value));
        if (selection.selectionSet) {
          visitSelectionSet(selection.selectionSet);
        }
      } else if (selection.kind === "InlineFragment") {
        visitSelectionSet(selection.selectionSet);
      } else {
        if (!visitedFragments.has(selection.name.value)) {
          visitedFragments.add(selection.name.value);
          const fragment = fragments.get(selection.name.value);
          if (fragment) {
            fragment.directives?.forEach((directive) =>
              directive.arguments?.forEach((arg) => visitValue(arg.value)),
            );
            visitSelectionSet(fragment.selectionSet);
          }
        }
      }
    }
  };
  visitSelectionSet(selectionSet);
  return used;
}

/** 收集选择集传递可达的片段名。 */
function collectReachableFragments(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
): Set<string> {
  const reachable = new Set<string>();
  const visit = (set: SelectionSetNode): void => {
    for (const selection of set.selections) {
      if (selection.kind === "FragmentSpread") {
        if (!reachable.has(selection.name.value)) {
          reachable.add(selection.name.value);
          const fragment = fragments.get(selection.name.value);
          if (fragment) {
            visit(fragment.selectionSet);
          }
        }
      } else if (selection.selectionSet) {
        visit(selection.selectionSet);
      }
    }
  };
  visit(selectionSet);
  return reachable;
}

/** 还原选择集中的类型条件（内联片段），并递归处理子选择集。 */
function transformSelectionSetBack(
  selectionSet: SelectionSetNode,
  namespace: string,
): SelectionSetNode {
  const selections: SelectionNode[] = selectionSet.selections.map((selection) => {
    if (selection.kind === "InlineFragment") {
      const inline: InlineFragmentNode = {
        ...selection,
        typeCondition: selection.typeCondition
          ? {
              ...selection.typeCondition,
              name: {
                ...selection.typeCondition.name,
                value: originalTypeName(namespace, selection.typeCondition.name.value),
              },
            }
          : undefined,
        selectionSet: transformSelectionSetBack(selection.selectionSet, namespace),
      };
      return inline;
    }
    if (selection.kind === "Field" && selection.selectionSet) {
      const field: FieldNode = {
        ...selection,
        selectionSet: transformSelectionSetBack(selection.selectionSet, namespace),
      };
      return field;
    }
    return selection;
  });
  return { ...selectionSet, selections };
}

/** 选择一个不与文档中现有名称冲突的注入别名。 */
function pickTypenameAlias(document: DocumentNode): string {
  const taken = new Set<string>();
  const scanValue = (value: ValueNode): void => {
    if (value.kind === "ListValue") {
      value.values.forEach(scanValue);
    } else if (value.kind === "ObjectValue") {
      value.fields.forEach((field) => {
        taken.add(field.name.value);
        scanValue(field.value);
      });
    }
  };
  const scanSelectionSet = (set: SelectionSetNode): void => {
    for (const selection of set.selections) {
      if (selection.kind === "Field") {
        taken.add(selection.name.value);
        if (selection.alias) {
          taken.add(selection.alias.value);
        }
        selection.arguments?.forEach((arg) => scanValue(arg.value));
        if (selection.selectionSet) {
          scanSelectionSet(selection.selectionSet);
        }
      } else if (selection.kind !== "FragmentSpread") {
        scanSelectionSet(selection.selectionSet);
      }
    }
  };
  for (const definition of document.definitions) {
    if (definition.kind === "OperationDefinition" || definition.kind === "FragmentDefinition") {
      scanSelectionSet(definition.selectionSet);
    }
  }
  let alias = TYPENAME_ALIAS_BASE;
  while (taken.has(alias)) {
    alias = `${alias}_`;
  }
  return alias;
}

/** 在文档的每个选择集中注入 `alias: __typename`，用于还原运行时类型。 */
function injectTypenameAlias(document: DocumentNode, alias: string): DocumentNode {
  const injectInto = (set: SelectionSetNode): SelectionSetNode => {
    const selections: SelectionNode[] = set.selections.map((selection) => {
      if (selection.kind === "Field" && selection.selectionSet) {
        return { ...selection, selectionSet: injectInto(selection.selectionSet) };
      }
      if (selection.kind === "InlineFragment") {
        return { ...selection, selectionSet: injectInto(selection.selectionSet) };
      }
      return selection;
    });
    const typenameField: FieldNode = {
      kind: Kind.FIELD,
      alias: { kind: Kind.NAME, value: alias },
      name: { kind: Kind.NAME, value: "__typename" },
    };
    return { ...set, selections: [...selections, typenameField] };
  };
  const definitions: DefinitionNode[] = document.definitions.map((definition) => {
    if (definition.kind === "OperationDefinition" || definition.kind === "FragmentDefinition") {
      return { ...definition, selectionSet: injectInto(definition.selectionSet) };
    }
    return definition;
  });
  return { ...document, definitions };
}

export interface BuildDelegationOptions {
  /** 该服务的原始 Schema。 */
  originalSchema: GraphQLSchema;
  namespace: string;
  /** 组合查询中的操作定义。 */
  operation: OperationDefinitionNode;
  /** 组合查询中的全部片段定义。 */
  fragments: ReadonlyMap<string, FragmentDefinitionNode>;
  /** 顶层同一响应键的字段节点（可能多个，需合并选择集）。 */
  fieldNodes: readonly FieldNode[];
  /** 已按组合操作定义合并默认值的变量。 */
  variableValues: Record<string, unknown>;
}

/**
 * 为某个命名空间根响应键构建委派请求：
 * 类型名还原、变量裁剪、片段裁剪，注入 __typename 别名，
 * 并保证委派文档通过原始 Schema 校验。
 */
export function buildDelegationRequest(options: BuildDelegationOptions): DelegationRequest {
  const { originalSchema, namespace, operation, fragments, fieldNodes, variableValues } = options;

  const mergedSelections: SelectionNode[] = [];
  for (const fieldNode of fieldNodes) {
    if (fieldNode.selectionSet) {
      mergedSelections.push(...fieldNode.selectionSet.selections);
    }
  }
  const mergedSelectionSet: SelectionSetNode = {
    kind: Kind.SELECTION_SET,
    selections: mergedSelections,
  };

  const reachableNames = collectReachableFragments(mergedSelectionSet, fragments);
  const fragmentDefinitions: FragmentDefinitionNode[] = [];
  for (const name of reachableNames) {
    const fragment = fragments.get(name);
    if (!fragment) {
      continue;
    }
    fragmentDefinitions.push({
      ...fragment,
      typeCondition: {
        ...fragment.typeCondition,
        name: {
          ...fragment.typeCondition.name,
          value: originalTypeName(namespace, fragment.typeCondition.name.value),
        },
      },
      selectionSet: transformSelectionSetBack(fragment.selectionSet, namespace),
    });
  }
  const reachableMap = new Map(fragmentDefinitions.map((def) => [def.name.value, def]));

  const transformedSelectionSet = transformSelectionSetBack(mergedSelectionSet, namespace);

  const usedVariables = collectUsedVariables(transformedSelectionSet, reachableMap);
  const variableDefinitions: VariableDefinitionNode[] = (operation.variableDefinitions ?? [])
    .filter((definition) => usedVariables.has(definition.variable.name.value))
    .map((definition) => ({
      ...definition,
      type: renameTypeNodeBack(definition.type, namespace),
    }));

  const delegatedOperation: OperationDefinitionNode = {
    kind: Kind.OPERATION_DEFINITION,
    operation: OperationTypeNode.QUERY,
    variableDefinitions,
    selectionSet: transformedSelectionSet,
  };
  let document: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [delegatedOperation, ...fragmentDefinitions],
  };

  const validationErrors = validate(originalSchema, document, specifiedRules);
  if (validationErrors.length > 0) {
    throw new Error(
      `Delegated document for namespace "${namespace}" failed validation: ${validationErrors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  const typenameAlias = pickTypenameAlias(document);
  document = injectTypenameAlias(document, typenameAlias);

  const delegatedVariables: Record<string, unknown> = {};
  for (const name of usedVariables) {
    if (Object.prototype.hasOwnProperty.call(variableValues, name)) {
      delegatedVariables[name] = variableValues[name];
    }
  }

  return { document, variableValues: delegatedVariables, typenameAlias };
}
