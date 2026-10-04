"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPOSED_QUERY_TYPE_NAME = void 0;
exports.composedTypeName = composedTypeName;
exports.buildComposedSchema = buildComposedSchema;
const graphql_1 = require("graphql");
/** 组合 Schema 根 Query 的类型名。 */
exports.COMPOSED_QUERY_TYPE_NAME = "Query";
/** 计算服务内类型在组合 Schema 中的名字。 */
function composedTypeName(namespace, typeName) {
    return `${namespace}_${typeName}`;
}
/**
 * 把一个服务的原始 Schema 复制一份，所有具名类型（除内置标量与内省类型外）
 * 统一改名为 `${namespace}_${原名}`；字段名、参数名、输入字段、枚举值保持不变。
 */
function renameSchemaTypes(schema, namespace) {
    const renamed = new Map();
    const renameType = (type) => {
        if ((0, graphql_1.isNonNullType)(type)) {
            return new graphql_1.GraphQLNonNull(renameType(type.ofType));
        }
        if ((0, graphql_1.isListType)(type)) {
            return new graphql_1.GraphQLList(renameType(type.ofType));
        }
        return renameNamed(type);
    };
    const renameNamed = (type) => {
        if ((0, graphql_1.isScalarType)(type) || type.name.startsWith("__")) {
            return type;
        }
        const cached = renamed.get(type.name);
        if (cached) {
            return cached;
        }
        const newName = composedTypeName(namespace, type.name);
        if ((0, graphql_1.isObjectType)(type)) {
            const objectType = new graphql_1.GraphQLObjectType({
                name: newName,
                description: type.description,
                fields: () => {
                    const fields = {};
                    for (const field of Object.values(type.getFields())) {
                        const args = {};
                        for (const arg of field.args) {
                            args[arg.name] = {
                                type: renameType(arg.type),
                                description: arg.description,
                                defaultValue: arg.defaultValue,
                                deprecationReason: arg.deprecationReason,
                            };
                        }
                        fields[field.name] = {
                            type: renameType(field.type),
                            args,
                            description: field.description,
                            deprecationReason: field.deprecationReason,
                        };
                    }
                    return fields;
                },
                interfaces: () => type.getInterfaces().map((iface) => renameNamed(iface)),
            });
            renamed.set(type.name, objectType);
            return objectType;
        }
        if ((0, graphql_1.isInterfaceType)(type)) {
            const interfaceType = new graphql_1.GraphQLInterfaceType({
                name: newName,
                description: type.description,
                fields: () => {
                    const fields = {};
                    for (const field of Object.values(type.getFields())) {
                        const args = {};
                        for (const arg of field.args) {
                            args[arg.name] = {
                                type: renameType(arg.type),
                                description: arg.description,
                                defaultValue: arg.defaultValue,
                                deprecationReason: arg.deprecationReason,
                            };
                        }
                        fields[field.name] = {
                            type: renameType(field.type),
                            args,
                            description: field.description,
                            deprecationReason: field.deprecationReason,
                        };
                    }
                    return fields;
                },
                interfaces: () => type.getInterfaces().map((iface) => renameNamed(iface)),
            });
            renamed.set(type.name, interfaceType);
            return interfaceType;
        }
        if ((0, graphql_1.isUnionType)(type)) {
            const unionType = new graphql_1.GraphQLUnionType({
                name: newName,
                description: type.description,
                types: () => type.getTypes().map((member) => renameNamed(member)),
            });
            renamed.set(type.name, unionType);
            return unionType;
        }
        if ((0, graphql_1.isEnumType)(type)) {
            const values = {};
            for (const value of type.getValues()) {
                values[value.name] = {
                    description: value.description,
                    deprecationReason: value.deprecationReason,
                };
            }
            const enumType = new graphql_1.GraphQLEnumType({
                name: newName,
                description: type.description,
                values,
            });
            renamed.set(type.name, enumType);
            return enumType;
        }
        if ((0, graphql_1.isInputObjectType)(type)) {
            const inputType = new graphql_1.GraphQLInputObjectType({
                name: newName,
                description: type.description,
                fields: () => {
                    const fields = {};
                    for (const field of Object.values(type.getFields())) {
                        const config = {
                            type: renameType(field.type),
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
        throw new Error(`Unsupported type kind for ${type.name}`);
    };
    for (const type of Object.values(schema.getTypeMap())) {
        renameNamed(type);
    }
    return renamed;
}
/** 由若干服务配置构建组合 Schema：Query 为根，每个命名空间一个可空字段。 */
function buildComposedSchema(services) {
    const namespaces = new Set();
    const queryFields = {};
    const extraTypes = [];
    for (const service of services) {
        if (namespaces.has(service.namespace)) {
            throw new Error(`Duplicate namespace: ${service.namespace}`);
        }
        namespaces.add(service.namespace);
        const original = (0, graphql_1.buildSchema)(service.sdl);
        const originalQuery = original.getQueryType();
        if (!originalQuery) {
            throw new Error(`Service ${service.namespace} has no query root type`);
        }
        const renamed = renameSchemaTypes(original, service.namespace);
        const renamedQuery = renamed.get(originalQuery.name);
        if (!renamedQuery || !(0, graphql_1.isObjectType)(renamedQuery)) {
            throw new Error(`Service ${service.namespace} query root could not be renamed`);
        }
        queryFields[service.namespace] = { type: renamedQuery };
        for (const type of renamed.values()) {
            if (type !== renamedQuery) {
                extraTypes.push(type);
            }
        }
    }
    return new graphql_1.GraphQLSchema({
        query: new graphql_1.GraphQLObjectType({
            name: exports.COMPOSED_QUERY_TYPE_NAME,
            fields: queryFields,
        }),
        types: extraTypes,
    });
}
