import {
  GraphQLError,
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  Kind,
  getDirectiveValues,
  getOperationAST,
  isAbstractType,
  isCompositeType,
  isListType,
  isNonNullType,
  isObjectType,
  type DocumentNode,
  type ExecutionResult,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLCompositeType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type GraphQLType,
  type SelectionSetNode,
} from "graphql";
import { composedTypeName } from "./schema.js";

export interface TransformOptions {
  originalSchema: GraphQLSchema;
  namespace: string;
  /** 委派文档（已注入 __typename 别名）。 */
  document: DocumentNode;
  typenameAlias: string;
  /** 已合并默认值的变量。 */
  variableValues: Record<string, unknown>;
  /** 上游执行结果。 */
  result: ExecutionResult;
  /** 组合查询中的顶层响应键。 */
  responseKey: string;
}

export interface TransformedResult {
  value: unknown;
  errors: GraphQLError[];
}

interface WalkContext {
  schema: GraphQLSchema;
  namespace: string;
  typenameAlias: string;
  variableValues: Record<string, unknown>;
  fragments: Map<string, FragmentDefinitionNode>;
}

function shouldInclude(
  node: Parameters<typeof getDirectiveValues>[1],
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

/** 收集某实际对象类型下生效的字段，按响应键分组（保持出现顺序）。 */
function collectFieldsForObject(
  ctx: WalkContext,
  objectType: GraphQLObjectType,
  selectionSet: SelectionSetNode,
): Map<string, FieldNode[]> {
  const byKey = new Map<string, FieldNode[]>();
  const matches = (typeName: string): boolean => {
    if (typeName === objectType.name) {
      return true;
    }
    const conditionType = ctx.schema.getType(typeName);
    if (!conditionType || !isAbstractType(conditionType)) {
      return false;
    }
    return ctx.schema
      .getPossibleTypes(conditionType)
      .some((member) => member.name === objectType.name);
  };
  const visit = (set: SelectionSetNode): void => {
    for (const selection of set.selections) {
      if (!shouldInclude(selection, ctx.variableValues)) {
        continue;
      }
      if (selection.kind === Kind.FIELD) {
        const key = selection.alias?.value ?? selection.name.value;
        const list = byKey.get(key);
        if (list) {
          list.push(selection);
        } else {
          byKey.set(key, [selection]);
        }
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (!selection.typeCondition || matches(selection.typeCondition.name.value)) {
          visit(selection.selectionSet);
        }
      } else {
        const fragment = ctx.fragments.get(selection.name.value);
        if (fragment && matches(fragment.typeCondition.name.value)) {
          visit(fragment.selectionSet);
        }
      }
    }
  };
  visit(selectionSet);
  return byKey;
}

function transformValue(
  ctx: WalkContext,
  value: unknown,
  type: GraphQLType,
  selectionSet: SelectionSetNode | undefined,
): void {
  if (value === null || value === undefined) {
    return;
  }
  if (isNonNullType(type)) {
    transformValue(ctx, value, type.ofType, selectionSet);
    return;
  }
  if (isListType(type)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        transformValue(ctx, item, type.ofType, selectionSet);
      }
    }
    return;
  }
  if (selectionSet && typeof value === "object" && !Array.isArray(value) && isCompositeType(type)) {
    transformObject(ctx, value as Record<string, unknown>, type, selectionSet);
  }
}

function transformObject(
  ctx: WalkContext,
  value: Record<string, unknown>,
  staticType: GraphQLCompositeType,
  selectionSet: SelectionSetNode,
): void {
  const injected = value[ctx.typenameAlias];
  let objectType: GraphQLObjectType | null = null;
  if (typeof injected === "string") {
    const actual = ctx.schema.getType(injected);
    if (actual && isObjectType(actual)) {
      objectType = actual;
    }
  }
  if (!objectType) {
    if (!isObjectType(staticType)) {
      return;
    }
    objectType = staticType;
  }

  const grouped = collectFieldsForObject(ctx, objectType, selectionSet);
  for (const key of Object.keys(value)) {
    if (!grouped.has(key)) {
      delete value[key];
    }
  }
  for (const [key, nodes] of grouped) {
    if (key === ctx.typenameAlias) {
      delete value[key];
      continue;
    }
    const fieldName = nodes[0].name.value;
    if (fieldName === "__typename") {
      const raw = value[key];
      if (typeof raw === "string") {
        value[key] = composedTypeName(ctx.namespace, raw);
      }
      continue;
    }
    const fieldDef = objectType.getFields()[fieldName];
    if (!fieldDef) {
      continue;
    }
    const childValue = value[key];
    if (childValue === null || childValue === undefined) {
      continue;
    }
    const childSelections = nodes.flatMap((node) =>
      node.selectionSet ? [...node.selectionSet.selections] : [],
    );
    const childSelectionSet: SelectionSetNode | undefined =
      childSelections.length > 0
        ? { kind: Kind.SELECTION_SET, selections: childSelections }
        : undefined;
    transformValue(ctx, childValue, fieldDef.type, childSelectionSet);
  }
}

/** 把上游结果转换为组合语义：__typename 改名、注入字段剔除、错误路径加前缀。 */
export function transformServiceResult(options: TransformOptions): TransformedResult {
  const {
    originalSchema,
    namespace,
    document,
    typenameAlias,
    variableValues,
    result,
    responseKey,
  } = options;

  const errors: GraphQLError[] = [];
  for (const error of result.errors ?? []) {
    errors.push(
      new GraphQLError(error.message, {
        nodes: error.nodes,
        path: [responseKey, ...(error.path ?? [])],
        extensions: error.extensions,
      }),
    );
  }

  if (result.data === null || result.data === undefined) {
    return { value: null, errors };
  }

  const data = JSON.parse(JSON.stringify(result.data)) as Record<string, unknown>;
  const operation = getOperationAST(document, undefined);
  const queryType = originalSchema.getQueryType();
  if (operation && queryType) {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const definition of document.definitions) {
      if (definition.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(definition.name.value, definition);
      }
    }
    const ctx: WalkContext = {
      schema: originalSchema,
      namespace,
      typenameAlias,
      variableValues,
      fragments,
    };
    transformObject(ctx, data, queryType, operation.selectionSet);
  }

  return { value: data, errors };
}
