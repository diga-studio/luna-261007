import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchema, validate } from "graphql";
import { createNamespaceGateway } from "../src/index.js";
import { makeUpstream, referenceExecute } from "./helpers.js";

const sdl = /* GraphQL */ `
  type Invoice {
    id: ID!
    total: Int!
  }
  type User {
    name: String!
  }
  type Query {
    invoice: Invoice!
    user: User
  }
`;

const schema = buildSchema(sdl);

const serviceData = {
  invoice: {
    id: "i1",
    get total(): number {
      throw new Error("total exploded");
    },
  },
  user: { name: "bob" },
};

const QUERY = /* GraphQL */ `
  {
    a: svc {
      invoice {
        id
        total
      }
    }
    b: svc {
      user {
        name
      }
    }
  }
`;

test("non-null error in one alias leaves the sibling alias of the same service intact", async () => {
  const upstream = makeUpstream(schema, serviceData);
  const gateway = createNamespaceGateway([
    { namespace: "svc", sdl, execute: upstream.execute },
  ]);

  const result = await gateway.execute(QUERY);

  for (const call of upstream.calls) {
    assert.deepEqual(validate(schema, call.document), [], "delegated document must be valid");
  }

  const reference = await referenceExecute(gateway.schema, { svc: serviceData }, QUERY);
  const normalize = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));
  const bare = (errs: ReadonlyArray<{ message: string; path?: unknown }> | undefined) =>
    (errs ?? []).map((e) => ({ message: e.message, path: e.path ?? null }));
  assert.deepEqual(normalize(result.data), normalize(reference.data));
  assert.deepEqual(bare(result.errors), bare(reference.errors));

  const data = result.data as Record<string, unknown>;
  assert.equal(data.a, null, "non-null error propagates to the nullable namespace root");
  assert.deepEqual(normalize(data.b), { user: { name: "bob" } }, "sibling alias keeps its data");

  const errors = result.errors ?? [];
  assert.equal(errors.length, 1, "the same upstream error must not be duplicated");
  assert.equal(errors[0]!.message, "total exploded", "upstream error message is preserved");
  assert.deepEqual(
    errors[0]!.path,
    ["a", "invoice", "total"],
    "error path is the full composed response path",
  );
});
