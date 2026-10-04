import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchema, print, validate } from "graphql";
import { createNamespaceGateway } from "../src/index.js";
import { makeUpstream, referenceExecute } from "./helpers.js";

const sdl = /* GraphQL */ `
  union SearchResult = User | Invoice
  type User {
    name: String!
    friends: [User!]
  }
  type Invoice {
    id: ID!
  }
  type Query {
    search: [SearchResult!]
    me: User
  }
`;

const schema = buildSchema(sdl);

const serviceData = {
  search: [
    { __typename: "User", name: "u1", friends: [{ name: "f1" }] },
    { __typename: "Invoice", id: "i9" },
  ],
  me: { name: "me" },
};

const QUERY = /* GraphQL */ `
  query Q($withFriends: Boolean! = true) {
    svc {
      search {
        ... on svc_User {
          name
          friends @include(if: $withFriends) {
            name
          }
        }
        ... on svc_Invoice {
          id
        }
      }
      me {
        kind: __typename
        name
      }
    }
  }
`;

test("unions, include directive, aliased __typename and recursive types", async () => {
  const upstream = makeUpstream(schema, serviceData);
  const gateway = createNamespaceGateway([{ namespace: "svc", sdl, execute: upstream.execute }]);

  const result = await gateway.execute(QUERY);

  assert.equal(upstream.calls.length, 1);
  const doc = upstream.calls[0]!.document;
  assert.deepEqual(validate(schema, doc), [], "delegated document must be valid");
  const printed = print(doc);
  assert.match(printed, /\.\.\. on User/, "fragment condition restored to original name");
  assert.match(printed, /__ns_typename: __typename/, "typename injected for union discrimination");
  assert.deepEqual(upstream.calls[0]!.variables, { withFriends: true });

  const reference = await referenceExecute(gateway.schema, { svc: serviceData }, QUERY);
  const normalize = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));
  assert.deepEqual(normalize(result.errors), normalize(reference.errors));
  assert.deepEqual(normalize(result.data), normalize(reference.data));

  const svc = (result.data as Record<string, unknown>).svc as Record<string, unknown>;
  const search = svc.search as Array<Record<string, unknown>>;
  assert.deepEqual(normalize(search[0]), { name: "u1", friends: [{ name: "f1" }] });
  assert.deepEqual(normalize(search[1]), { id: "i9" });
  assert.ok(!("__ns_typename" in search[0]!), "injected key stripped from list items");
  const me = svc.me as Record<string, unknown>;
  assert.equal(me.kind, "svc_User", "aliased __typename returns composed name");

  const upstream2 = makeUpstream(schema, serviceData);
  const gateway2 = createNamespaceGateway([{ namespace: "svc", sdl, execute: upstream2.execute }]);
  const result2 = await gateway2.execute(QUERY, { withFriends: false });
  const svc2 = (result2.data as Record<string, unknown>).svc as Record<string, unknown>;
  const first = (svc2.search as Array<Record<string, unknown>>)[0]!;
  assert.ok(!("friends" in first), "@include(if: false) drops the field");
  const reference2 = await referenceExecute(gateway2.schema, { svc: serviceData }, QUERY, {
    withFriends: false,
  });
  assert.deepEqual(normalize(result2.data), normalize(reference2.data));
});
