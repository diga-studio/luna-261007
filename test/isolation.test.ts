import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchema, print, validate } from "graphql";
import { createNamespaceGateway } from "../src/index.js";
import { makeUpstream, referenceExecute } from "./helpers.js";

const sdlA = /* GraphQL */ `
  interface Node {
    id: ID!
  }
  type User implements Node {
    id: ID!
    name: String!
  }
  type Invoice implements Node {
    id: ID!
    status: InvoiceStatus!
    owner: User!
  }
  enum InvoiceStatus {
    PAID
    User
  }
  type Query {
    node: Node
    user: User!
    usersByStatus(status: InvoiceStatus = PAID): [User!]
  }
`;

const sdlB = /* GraphQL */ `
  type User {
    id: ID!
    email: String!
  }
  type Invoice {
    id: ID!
    memo: String
  }
  input InvoiceFilter {
    memo: String = "User"
  }
  type Query {
    user: User!
    invoices(filter: InvoiceFilter): [Invoice!]
  }
`;

const schemaA = buildSchema(sdlA);
const schemaB = buildSchema(sdlB);

const dataA = {
  node: { __typename: "Invoice", id: "User", status: "User", owner: { id: "u1", name: "Invoice" } },
  user: { id: "u1", name: "User" },
  usersByStatus: (args: { status?: string }) => [{ id: "u1", name: `status:${args.status ?? "?"}` }],
};

const dataB = {
  user: { id: "b1", email: "b@example.com" },
  invoices: (args: { filter?: { memo?: string } }) => [
    { id: "inv-b", memo: args.filter?.memo ?? null },
  ],
};

const QUERY = /* GraphQL */ `
  query Q($status: a_InvoiceStatus = User, $memo: String = "Invoice", $skipIt: Boolean = true) {
    a {
      user {
        ...userFieldsA
      }
      node {
        ... on a_User {
          name
        }
        ... on a_Invoice {
          id
          status
        }
      }
      usersByStatus(status: $status) {
        name
      }
    }
    b {
      user {
        ...userFieldsB
      }
      invoices(filter: { memo: $memo }) {
        id
        memo
      }
    }
    skipped: b @skip(if: $skipIt) {
      user {
        id
      }
    }
  }
  fragment userFieldsA on a_User {
    __typename
    id
    name
  }
  fragment userFieldsB on b_User {
    id
    email
  }
`;

test("fragments and default input variables stay isolated between same-named services", async () => {
  const upstreamA = makeUpstream(schemaA, dataA);
  const upstreamB = makeUpstream(schemaB, dataB);
  const gateway = createNamespaceGateway([
    { namespace: "a", sdl: sdlA, execute: upstreamA.execute },
    { namespace: "b", sdl: sdlB, execute: upstreamB.execute },
  ]);

  const result = await gateway.execute(QUERY);

  assert.equal(upstreamA.calls.length, 1, "service a called exactly once");
  assert.equal(upstreamB.calls.length, 1, "service b called exactly once (skipped key must not call upstream)");

  const docA = upstreamA.calls[0]!.document;
  const docB = upstreamB.calls[0]!.document;
  assert.deepEqual(validate(schemaA, docA), [], "delegated document for a must be valid");
  assert.deepEqual(validate(schemaB, docB), [], "delegated document for b must be valid");

  const printedA = print(docA);
  assert.match(printedA, /\$status: InvoiceStatus = User/, "default enum value keeps original type name");
  assert.doesNotMatch(printedA, /a_InvoiceStatus/, "no composed type name leaks into delegated doc");
  assert.doesNotMatch(print(docB), /\$status/, "service b never sees service a variables");
  assert.doesNotMatch(print(docB), /b_Invoice|b_User/, "no composed type name leaks into delegated doc");

  assert.deepEqual(upstreamA.calls[0]!.variables, { status: "User" });
  assert.deepEqual(upstreamB.calls[0]!.variables, { memo: "Invoice" });

  const reference = await referenceExecute(gateway.schema, { a: dataA, b: dataB }, QUERY);
  const normalize = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));
  assert.deepEqual(normalize(result.errors), normalize(reference.errors));
  assert.deepEqual(normalize(result.data), normalize(reference.data));

  const a = result.data!.a as Record<string, unknown>;
  const user = a.user as Record<string, unknown>;
  assert.equal(user.__typename, "a_User", "__typename uses composed name");
  assert.equal(user.name, "User", "business string equal to a type name is preserved");
  const node = a.node as Record<string, unknown>;
  assert.equal(node.id, "User", "ID equal to a type name is preserved");
  assert.equal(node.status, "User", "enum value equal to a type name is preserved");
  assert.ok(!("__ns_typename" in node), "injected typename key is stripped");
  assert.equal(
    (a.usersByStatus as Array<Record<string, unknown>>)[0]!.name,
    "status:User",
    "default variable value reaches upstream",
  );
  assert.ok(!("skipped" in result.data!), "skipped root key is absent from data");
});
