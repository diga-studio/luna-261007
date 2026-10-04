import {
  buildSchema,
  execute,
  isAbstractType,
  isObjectType,
  parse,
  type DocumentNode,
  type ExecutionResult,
  type GraphQLFieldResolver,
  type GraphQLObjectType,
  type GraphQLSchema,
} from "graphql";
import { buildComposedSchema } from "../src/schema.js";
import type { ServiceConfig } from "../src/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyResolver = (source: any, args: any, context?: any, info?: any) => any;
export type ResolverMap = Record<string, Record<string, AnyResolver>>;

export interface RecordedCall {
  document: DocumentNode;
  variableValues: Record<string, unknown>;
}

export interface TestService {
  config: ServiceConfig;
  schema: GraphQLSchema;
  calls: RecordedCall[];
}

/** 把解析器挂到由 SDL 构建的 Schema 上，模拟一个真实的内部服务。 */
export function attachResolvers(schema: GraphQLSchema, resolvers: ResolverMap): void {
  for (const [typeName, fields] of Object.entries(resolvers)) {
    const type = schema.getType(typeName);
    if (!type || !isObjectType(type)) {
      throw new Error(`Cannot attach resolvers: unknown object type ${typeName}`);
    }
    const fieldMap = type.getFields();
    for (const [fieldName, resolver] of Object.entries(fields)) {
      const field = fieldMap[fieldName];
      if (!field) {
        throw new Error(`Cannot attach resolver: unknown field ${typeName}.${fieldName}`);
      }
      field.resolve = resolver as GraphQLFieldResolver<unknown, unknown>;
    }
  }
}

/** 构造一个测试服务：SDL + 解析器，执行走 graphql-js，调用被记录。 */
export function makeService(
  namespace: string,
  sdl: string,
  resolvers: ResolverMap,
): TestService {
  const schema = buildSchema(sdl);
  attachResolvers(schema, resolvers);
  const calls: RecordedCall[] = [];
  const config: ServiceConfig = {
    namespace,
    sdl,
    execute: (document, variableValues) => {
      calls.push({ document, variableValues });
      return execute({ schema, document, variableValues }) as ExecutionResult;
    },
  };
  return { config, schema, calls };
}

/**
 * 用同一份解析器在“同语义组合 Schema”上直接执行，作为参照结果。
 * 组合 Schema 由库的 buildComposedSchema 生成，解析器按改名规则重新挂载。
 */
export function executeOnComposedSchema(options: {
  services: { namespace: string; sdl: string; resolvers: ResolverMap }[];
  query: string;
  variableValues?: Record<string, unknown>;
  operationName?: string;
}): ExecutionResult {
  const { services, query, variableValues, operationName } = options;
  const stubConfigs: ServiceConfig[] = services.map((service) => ({
    namespace: service.namespace,
    sdl: service.sdl,
    execute: () => {
      throw new Error("reference schema must not delegate");
    },
  }));
  const schema = buildComposedSchema(stubConfigs);

  for (const service of services) {
    const queryType = schema.getQueryType() as GraphQLObjectType;
    const rootField = queryType.getFields()[service.namespace];
    rootField.resolve = () => ({});
    for (const [typeName, fields] of Object.entries(service.resolvers)) {
      if (typeName === "Query") {
        continue;
      }
      const renamedType = schema.getType(`${service.namespace}_${typeName}`);
      if (!renamedType || !isObjectType(renamedType)) {
        throw new Error(`reference: missing composed type ${service.namespace}_${typeName}`);
      }
      const fieldMap = renamedType.getFields();
      for (const [fieldName, resolver] of Object.entries(fields)) {
        const field = fieldMap[fieldName];
        if (!field) {
          throw new Error(`reference: missing field ${service.namespace}_${typeName}.${fieldName}`);
        }
        field.resolve = resolver as GraphQLFieldResolver<unknown, unknown>;
      }
    }
    const queryResolvers = service.resolvers["Query"] ?? {};
    const renamedQuery = schema.getType(`${service.namespace}_Query`);
    if (renamedQuery && isObjectType(renamedQuery)) {
      const fieldMap = renamedQuery.getFields();
      for (const [fieldName, resolver] of Object.entries(queryResolvers)) {
        const field = fieldMap[fieldName];
        if (!field) {
          throw new Error(`reference: missing field ${service.namespace}_Query.${fieldName}`);
        }
        field.resolve = resolver as GraphQLFieldResolver<unknown, unknown>;
      }
    }
  }

  // 抽象类型的运行时类型判别：fixture 对象携带原始 __typename，映射到组合类型名。
  for (const service of services) {
    for (const type of Object.values(schema.getTypeMap())) {
      if (!type.name.startsWith(`${service.namespace}_`) || !isAbstractType(type)) {
        continue;
      }
      type.resolveType = (value) => {
        const raw = (value as { __typename?: string }).__typename;
        return raw ? `${service.namespace}_${raw}` : undefined;
      };
    }
  }

  return execute({
    schema,
    document: parse(query),
    variableValues,
    operationName,
  }) as ExecutionResult;
}
