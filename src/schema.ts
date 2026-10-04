import {
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
} from 'graphql';
import type { ArticleRow, CmsDatabase } from './db';
import type { PageArgs } from './types';

const pageArguments = {
  offset: { type: GraphQLInt, defaultValue: 0 },
  limit: { type: GraphQLInt, defaultValue: 20 },
} as const;

export function buildSchema(db: CmsDatabase): GraphQLSchema {
  const articleType: GraphQLObjectType = new GraphQLObjectType({
    name: 'Article',
    fields: () => ({
      id: { type: new GraphQLNonNull(GraphQLID) },
      rank: { type: new GraphQLNonNull(GraphQLInt) },
      related: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(articleType))),
        args: pageArguments,
        resolve: (parent: ArticleRow, args: PageArgs) =>
          db.queryRelated(parent.id, args),
      },
    }),
  });

  const queryType = new GraphQLObjectType({
    name: 'Query',
    fields: {
      articles: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(articleType))),
        args: pageArguments,
        resolve: (_parent: unknown, args: PageArgs) => db.queryArticles(args),
      },
    },
  });

  return new GraphQLSchema({ query: queryType });
}
