import {
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLUnionType,
  buildSchema,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  type GraphQLArgumentConfig,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfig,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
  type GraphQLNamedType,
  type GraphQLNullableType,
  type GraphQLOutputType,
  type GraphQLType,
} from "graphql";
import type { ServiceConfig } from "./types.js";

/** 组合 Schema 根 Query 的类型名。 */
export const COMPOSED_QUERY_TYPE_NAME = "Query";

/** 计算服务内类型在组合 Schema 中的名字。 */
export function composedTypeName(namespace: string, typeName: string): string {
  return `${namespace}_${typeName}`;
}

/**
 * 把一个服务的原始 Schema 复制一份，所有具名类型（除内置标量与内省类型外）
 * 统一改名为 `${namespace}_${原名}`；字段名、参数名、输入字段、枚举值保持不变。
 */
function renameSchemaTypes(
  schema: GraphQLSchema,
  namespace: string,
): Map<string, GraphQLNamedType> {
  const renamed = new Map<string, GraphQLNamedType>();

  const renameType = (type: GraphQLType): GraphQLType => {
    if (isNonNullType(type)) {
      return new GraphQLNonNull(renameType(type.ofType) as GraphQLNullableType);
    }
    if (isListType(type)) {
      return new GraphQLList(renameType(type.ofType));
    }
    return renameNamed(type as GraphQLNamedType);
  };

  const renameNamed = (type: GraphQLNamedType): GraphQLNamedType => {
    if (isScalarType(type) || type.name.startsWith("__")) {
      return type;
    }
    const cached = renamed.get(type.name);
    if (cached) {
      return cached;
    }
    const newName = composedTypeName(namespace, type.name);
    if (isObjectType(type)) {
      const objectType = new GraphQLObjectType({
        name: newName,
        description: type.description,
        fields: (): GraphQLFieldConfigMap<unknown, unknown> => {
          const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
          for (const field of Object.values(type.getFields())) {
            const args: Record<string, GraphQLArgumentConfig> = {};
            for (const arg of field.args) {
              args[arg.name] = {
                type: renameType(arg.type) as GraphQLInputType,
                description: arg.description,
                defaultValue: arg.defaultValue,
                deprecationReason: arg.deprecationReason,
              };
            }
            fields[field.name] = {
              type: renameType(field.type) as GraphQLOutputType,
              args,
              description: field.description,
              deprecationReason: field.deprecationReason,
            };
          }
          return fields;
        },
        interfaces: () =>
          type.getInterfaces().map((iface) => renameNamed(iface) as GraphQLInterfaceType),
      });
      renamed.set(type.name, objectType);
      return objectType;
    }
    if (isInterfaceType(type)) {
      const interfaceType = new GraphQLInterfaceType({
        name: newName,
        description: type.description,
        fields: (): GraphQLFieldConfigMap<unknown, unknown> => {
          const fields: GraphQLFieldConfigMap<unknown, unknown> = {};
          for (const field of Object.values(type.getFields())) {
            const args: Record<string, GraphQLArgumentConfig> = {};
            for (const arg of field.args) {
              args[arg.name] = {
                type: renameType(arg.type) as GraphQLInputType,
                description: arg.description,
                defaultValue: arg.defaultValue,
                deprecationReason: arg.deprecationReason,
              };
            }
            fields[field.name] = {
              type: renameType(field.type) as GraphQLOutputType,
              args,
              description: field.description,
              deprecationReason: field.deprecationReason,
            };
          }
          return fields;
        },
        interfaces: () =>
          type.getInterfaces().map((iface) => renameNamed(iface) as GraphQLInterfaceType),
      });
      renamed.set(type.name, interfaceType);
      return interfaceType;
    }
    if (isUnionType(type)) {
      const unionType = new GraphQLUnionType({
        name: newName,
        description: type.description,
        types: () => type.getTypes().map((member) => renameNamed(member) as GraphQLObjectType),
      });
      renamed.set(type.name, unionType);
      return unionType;
    }
    if (isEnumType(type)) {
      const values: Record<string, { description?: string | null; deprecationReason?: string | null }> = {};
      for (const value of type.getValues()) {
        values[value.name] = {
          description: value.description,
          deprecationReason: value.deprecationReason,
        };
      }
      const enumType = new GraphQLEnumType({
        name: newName,
        description: type.description,
        values,
      });
      renamed.set(type.name, enumType);
      return enumType;
    }
    if (isInputObjectType(type)) {
      const inputType = new GraphQLInputObjectType({
        name: newName,
        description: type.description,
        fields: (): GraphQLInputFieldConfigMap => {
          const fields: GraphQLInputFieldConfigMap = {};
          for (const field of Object.values(type.getFields())) {
            const config: GraphQLInputFieldConfig = {
              type: renameType(field.type) as GraphQLInputType,
              description: field.description,
              defaultValue: field.defaultValue,
              deprecationReason: field.deprecationReason,
            };
            fields[field.name] = config;
          }
          return fields;
        },
      });
      renamed.set(type.name, inputType);
      return inputType;
    }
    throw new Error(`Unsupported type kind for ${(type as GraphQLNamedType).name}`);
  };

  for (const type of Object.values(schema.getTypeMap())) {
    renameNamed(type);
  }
  return renamed;
}

/** 由若干服务配置构建组合 Schema：Query 为根，每个命名空间一个可空字段。 */
export function buildComposedSchema(services: ServiceConfig[]): GraphQLSchema {
  const namespaces = new Set<string>();
  const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  const extraTypes: GraphQLNamedType[] = [];

  for (const service of services) {
    if (namespaces.has(service.namespace)) {
      throw new Error(`Duplicate namespace: ${service.namespace}`);
    }
    namespaces.add(service.namespace);
    const original = buildSchema(service.sdl);
    const originalQuery = original.getQueryType();
    if (!originalQuery) {
      throw new Error(`Service ${service.namespace} has no query root type`);
    }
    const renamed = renameSchemaTypes(original, service.namespace);
    const renamedQuery = renamed.get(originalQuery.name);
    if (!renamedQuery || !isObjectType(renamedQuery)) {
      throw new Error(`Service ${service.namespace} query root could not be renamed`);
    }
    queryFields[service.namespace] = { type: renamedQuery };
    for (const type of renamed.values()) {
      if (type !== renamedQuery) {
        extraTypes.push(type);
      }
    }
  }

  return new GraphQLSchema({
    query: new GraphQLObjectType({
      name: COMPOSED_QUERY_TYPE_NAME,
      fields: queryFields,
    }),
    types: extraTypes,
  });
}
