import {
  Kind,
  parse,
  type ArgumentNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql';
import type { CmsDatabase } from './db';

const DEFAULT_OFFSET = 0;
const DEFAULT_LIMIT = 20;

interface ArticleRow {
  id: number;
  rank: number;
}

interface ExecContext {
  db: CmsDatabase;
  fragments: Map<string, FragmentDefinitionNode>;
  variables: Record<string, unknown>;
}

export function executeQuery(
  db: CmsDatabase,
  document: string,
  variables: Record<string, unknown> = {},
): unknown {
  const ast: DocumentNode = parse(document);
  const fragments = new Map<string, FragmentDefinitionNode>();
  const operations: OperationDefinitionNode[] = [];
  for (const def of ast.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(def.name.value, def);
    } else if (def.kind === Kind.OPERATION_DEFINITION) {
      operations.push(def);
    }
  }
  if (operations.length !== 1) {
    throw new Error(`expected exactly one operation, got ${operations.length}`);
  }
  const operation = operations[0];
  if (operation.operation !== 'query') {
    throw new Error(`unsupported operation type: ${operation.operation}`);
  }

  const resolvedVariables: Record<string, unknown> = { ...variables };
  for (const varDef of operation.variableDefinitions ?? []) {
    const name = varDef.variable.name.value;
    if (!(name in resolvedVariables) && varDef.defaultValue) {
      resolvedVariables[name] = valueFromAst(varDef.defaultValue, resolvedVariables);
    }
  }

  const ctx: ExecContext = { db, fragments, variables: resolvedVariables };
  const data = executeSelectionSet(ctx, 'Query', null, operation.selectionSet);
  return { data };
}

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case Kind.VARIABLE:
      return variables[node.name.value];
    case Kind.INT:
      return parseInt(node.value, 10);
    case Kind.FLOAT:
      return parseFloat(node.value);
    case Kind.STRING:
    case Kind.ENUM:
      return node.value;
    case Kind.BOOLEAN:
      return node.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map((v) => valueFromAst(v, variables));
    case Kind.OBJECT: {
      const obj: Record<string, unknown> = {};
      for (const field of node.fields) {
        obj[field.name.value] = valueFromAst(field.value, variables);
      }
      return obj;
    }
  }
}

function shouldInclude(
  ctx: ExecContext,
  directives: readonly { name: { value: string }; arguments?: readonly ArgumentNode[] }[] | undefined,
): boolean {
  for (const directive of directives ?? []) {
    const name = directive.name.value;
    if (name !== 'skip' && name !== 'include') {
      throw new Error(`unsupported directive: @${name}`);
    }
    const ifArg = (directive.arguments ?? []).find((a) => a.name.value === 'if');
    if (!ifArg) {
      throw new Error(`@${name} requires an "if" argument`);
    }
    const value = valueFromAst(ifArg.value, ctx.variables);
    if (typeof value !== 'boolean') {
      throw new Error(`@${name}(if:) must be a boolean`);
    }
    if (name === 'skip' && value) return false;
    if (name === 'include' && !value) return false;
  }
  return true;
}

function collectFields(
  ctx: ExecContext,
  typeName: string,
  selectionSet: SelectionSetNode,
): Map<string, FieldNode[]> {
  const grouped = new Map<string, FieldNode[]>();
  const visit = (set: SelectionSetNode): void => {
    for (const selection of set.selections) {
      if (!shouldInclude(ctx, 'directives' in selection ? selection.directives : undefined)) {
        continue;
      }
      if (selection.kind === Kind.FIELD) {
        const key = selection.alias?.value ?? selection.name.value;
        const list = grouped.get(key) ?? [];
        list.push(selection);
        grouped.set(key, list);
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = ctx.fragments.get(selection.name.value);
        if (!fragment) {
          throw new Error(`unknown fragment: ${selection.name.value}`);
        }
        if (!shouldInclude(ctx, fragment.directives)) continue;
        checkTypeCondition(fragment.typeCondition.name.value, typeName);
        visit(fragment.selectionSet);
      } else {
        if (selection.typeCondition) {
          checkTypeCondition(selection.typeCondition.name.value, typeName);
        }
        visit(selection.selectionSet);
      }
    }
  };
  visit(selectionSet);
  return grouped;
}

function checkTypeCondition(condition: string, typeName: string): void {
  if (condition !== typeName) {
    throw new Error(`fragment type condition "${condition}" cannot apply to "${typeName}"`);
  }
}

function getIntArgument(
  ctx: ExecContext,
  field: FieldNode,
  name: string,
  defaultValue: number,
): number {
  const arg = (field.arguments ?? []).find((a) => a.name.value === name);
  if (!arg) return defaultValue;
  const value = valueFromAst(arg.value, ctx.variables);
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`argument "${name}" must be an integer`);
  }
  if (value < 0) {
    throw new Error(`argument "${name}" must be non-negative`);
  }
  return value;
}

function queryArticles(
  ctx: ExecContext,
  fromId: number | null,
  offset: number,
  limit: number,
): ArticleRow[] {
  if (fromId === null) {
    const stmt = ctx.db.connection.prepare(
      'SELECT id, rank FROM articles WHERE published = 1 ORDER BY rank ASC, id ASC LIMIT ? OFFSET ?',
    );
    return stmt.all(limit, offset) as unknown as ArticleRow[];
  }
  const stmt = ctx.db.connection.prepare(
    `SELECT a.id, a.rank FROM edges e
     JOIN articles a ON a.id = e.to_id
     WHERE e.from_id = ? AND a.published = 1
     ORDER BY a.rank ASC, a.id ASC
     LIMIT ? OFFSET ?`,
  );
  return stmt.all(fromId, limit, offset) as unknown as ArticleRow[];
}

function executeSelectionSet(
  ctx: ExecContext,
  typeName: string,
  source: ArticleRow | null,
  selectionSet: SelectionSetNode,
): Record<string, unknown> {
  const grouped = collectFields(ctx, typeName, selectionSet);
  const result: Record<string, unknown> = {};
  for (const [responseKey, fields] of grouped) {
    result[responseKey] = executeField(ctx, typeName, source, fields);
  }
  return result;
}

function mergedSelectionSet(fields: FieldNode[]): SelectionSetNode {
  const selections = fields.flatMap((f) => f.selectionSet?.selections ?? []);
  return { kind: Kind.SELECTION_SET, selections };
}

function executeField(
  ctx: ExecContext,
  typeName: string,
  source: ArticleRow | null,
  fields: FieldNode[],
): unknown {
  const field = fields[0];
  const name = field.name.value;
  if (name === '__typename') return typeName;

  if (typeName === 'Query') {
    if (name !== 'articles') {
      throw new Error(`unknown field on Query: ${name}`);
    }
    const offset = getIntArgument(ctx, field, 'offset', DEFAULT_OFFSET);
    const limit = getIntArgument(ctx, field, 'limit', DEFAULT_LIMIT);
    const rows = queryArticles(ctx, null, offset, limit);
    const sub = mergedSelectionSet(fields);
    return rows.map((row) => executeSelectionSet(ctx, 'Article', row, sub));
  }

  if (name === 'id') {
    return String(source!.id);
  }
  if (name === 'rank') {
    return source!.rank;
  }
  if (name === 'related') {
    const offset = getIntArgument(ctx, field, 'offset', DEFAULT_OFFSET);
    const limit = getIntArgument(ctx, field, 'limit', DEFAULT_LIMIT);
    const rows = queryArticles(ctx, source!.id, offset, limit);
    const sub = mergedSelectionSet(fields);
    return rows.map((row) => executeSelectionSet(ctx, 'Article', row, sub));
  }
  throw new Error(`unknown field on Article: ${name}`);
}
