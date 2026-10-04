import assert from "node:assert/strict";
import test from "node:test";
import { print, validate, type ExecutionResult } from "graphql";
import { createGateway } from "../src/index.js";
import { executeOnComposedSchema, makeService, type TestService } from "./helpers.js";

const ACCT_SDL = `
interface Named { name: String! }
type Query {
  invoice(id: ID!, filter: InvoiceFilter): Invoice
  user(id: ID!): User
  search(text: String): [SearchHit!]!
  node: Named
}
type Invoice {
  id: ID!
  number: String!
  status: InvoiceStatus!
  owner: User!
  lines: [InvoiceLine!]!
}
type InvoiceLine { description: String!, amount: Float! }
type User implements Named { id: ID!, name: String!, kind: String }
union SearchHit = Invoice | User
enum InvoiceStatus { OPEN PAID VOID }
input InvoiceFilter { status: InvoiceStatus = OPEN, minAmount: Float = 10 }
`;

const BILLING_SDL = `
type Query {
  invoice(id: ID!, filter: InvoiceFilter): Invoice
  user(id: ID!): User
}
type Invoice {
  id: ID!
  number: String!
  status: InvoiceStatus!
  currency: String!
}
type User { id: ID!, email: String! }
enum InvoiceStatus { OPEN PAID VOID }
input InvoiceFilter { status: InvoiceStatus = PAID, tags: [String!] }
`;

function makeAcctService(receivedFilters: unknown[]): TestService {
  return makeService("acct", ACCT_SDL, {
    Query: {
      invoice: (_source, args: { id: string; filter?: unknown }) => {
        receivedFilters.push(args.filter);
        return {
          __typename: "Invoice",
          id: args.id,
          number: `A-${args.id}`,
          status: "OPEN",
          owner: { __typename: "User", id: "u1", name: "AcctUser", kind: "Invoice" },
          lines: [{ description: "Invoice", amount: 1.5 }],
        };
      },
      user: (_source, args: { id: string }) => ({
        __typename: "User",
        id: args.id,
        name: "AcctUser",
        kind: "User",
      }),
      search: () => [
        { __typename: "Invoice", id: "s1", number: "A-s1", status: "PAID",
          owner: { __typename: "User", id: "u2", name: "Second", kind: "User" }, lines: [] },
        { __typename: "User", id: "u9", name: "Ninth", kind: "User" },
      ],
      node: () => ({ __typename: "User", id: "u1", name: "AcctUser", kind: "User" }),
    },
  });
}

function makeBillingService(receivedFilters: unknown[]): TestService {
  return makeService("billing", BILLING_SDL, {
    Query: {
      invoice: (_source, args: { id: string; filter?: unknown }) => {
        receivedFilters.push(args.filter);
        return {
          __typename: "Invoice",
          id: args.id,
          number: `B-${args.id}`,
          status: "PAID",
          currency: "USD",
        };
      },
      user: (_source, args: { id: string }) => ({
        __typename: "User",
        id: args.id,
        email: "b@example.com",
      }),
    },
  });
}

function summarize(result: ExecutionResult) {
  return JSON.parse(
    JSON.stringify({
      data: result.data ?? null,
      errors: (result.errors ?? []).map((error) => ({
        message: error.message,
        path: error.path ?? null,
      })),
    }),
  ) as unknown;
}

test("同名类型服务之间的片段及默认输入变量隔离", async () => {
  const acctFilters: unknown[] = [];
  const billingFilters: unknown[] = [];
  const acct = makeAcctService(acctFilters);
  const billing = makeBillingService(billingFilters);
  const gateway = createGateway([acct.config, billing.config]);

  const query = `
    query GetBoth($af: acct_InvoiceFilter = {}, $bf: billing_InvoiceFilter = {}) {
      a: acct {
        invoice(id: "1", filter: $af) { ...AcctInv }
      }
      b: billing {
        invoice(id: "1", filter: $bf) { ...BillInv }
      }
    }
    fragment AcctInv on acct_Invoice {
      id
      number
      status
      owner { name kind }
    }
    fragment BillInv on billing_Invoice {
      id
      number
      status
      currency
    }
  `;

  const actual = await gateway.execute(query);
  const refAcctFilters: unknown[] = [];
  const refBillingFilters: unknown[] = [];
  const expected = executeOnComposedSchema({
    services: [
      { namespace: "acct", sdl: ACCT_SDL, resolvers: acctResolversForReference(refAcctFilters) },
      { namespace: "billing", sdl: BILLING_SDL, resolvers: billingResolversForReference(refBillingFilters) },
    ],
    query,
  });

  assert.deepEqual(summarize(actual), summarize(expected));
  assert.deepEqual(actual.data, {
    a: {
      invoice: {
        id: "1",
        number: "A-1",
        status: "OPEN",
        owner: { name: "AcctUser", kind: "Invoice" },
      },
    },
    b: {
      invoice: { id: "1", number: "B-1", status: "PAID", currency: "USD" },
    },
  });

  // 默认输入变量隔离：各自服务应用自己输入类型的字段默认值。
  const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  assert.deepEqual(normalize(acctFilters), [{ status: "OPEN", minAmount: 10 }]);
  assert.deepEqual(normalize(billingFilters), [{ status: "PAID" }]);
  assert.deepEqual(normalize(acctFilters), normalize(refAcctFilters));
  assert.deepEqual(normalize(billingFilters), normalize(refBillingFilters));

  // 委派文档必须通过对应原始 Schema 的校验，且类型名已还原。
  assert.equal(acct.calls.length, 1);
  assert.equal(billing.calls.length, 1);
  for (const call of acct.calls) {
    assert.deepEqual(validate(acct.schema, call.document), []);
    const printed = print(call.document);
    assert.match(printed, /fragment AcctInv on Invoice\b/);
    assert.doesNotMatch(printed, /acct_/);
    assert.match(printed, /\$af: InvoiceFilter = \{\}/);
  }
  for (const call of billing.calls) {
    assert.deepEqual(validate(billing.schema, call.document), []);
    const printed = print(call.document);
    assert.match(printed, /fragment BillInv on Invoice\b/);
    assert.doesNotMatch(printed, /billing_/);
  }

  // 委派变量只包含本服务用到的变量，默认值语义保持。
  assert.deepEqual(normalize(acct.calls[0].variableValues), {
    af: { status: "OPEN", minAmount: 10 },
  });
  assert.deepEqual(normalize(billing.calls[0].variableValues), { bf: { status: "PAID" } });
});

function acctResolversForReference(receivedFilters: unknown[]) {
  const service = makeAcctService(receivedFilters);
  void service;
  return {
    Query: {
      invoice: (_source: unknown, args: { id: string; filter?: unknown }) => {
        receivedFilters.push(args.filter);
        return {
          __typename: "Invoice",
          id: args.id,
          number: `A-${args.id}`,
          status: "OPEN",
          owner: { __typename: "User", id: "u1", name: "AcctUser", kind: "Invoice" },
          lines: [{ description: "Invoice", amount: 1.5 }],
        };
      },
      user: (_source: unknown, args: { id: string }) => ({
        __typename: "User",
        id: args.id,
        name: "AcctUser",
        kind: "User",
      }),
      search: () => [
        { __typename: "Invoice", id: "s1", number: "A-s1", status: "PAID",
          owner: { __typename: "User", id: "u2", name: "Second", kind: "User" }, lines: [] },
        { __typename: "User", id: "u9", name: "Ninth", kind: "User" },
      ],
      node: () => ({ __typename: "User", id: "u1", name: "AcctUser", kind: "User" }),
    },
  };
}

function billingResolversForReference(receivedFilters: unknown[]) {
  return {
    Query: {
      invoice: (_source: unknown, args: { id: string; filter?: unknown }) => {
        receivedFilters.push(args.filter);
        return {
          __typename: "Invoice",
          id: args.id,
          number: `B-${args.id}`,
          status: "PAID",
          currency: "USD",
        };
      },
      user: (_source: unknown, args: { id: string }) => ({
        __typename: "User",
        id: args.id,
        email: "b@example.com",
      }),
    },
  };
}

const PAY_SDL = `
type Query {
  invoice(id: ID!): Invoice
}
type Invoice {
  id: ID!
  total: Float!
  note: String
}
`;

function payResolvers() {
  return {
    Query: {
      invoice: (_source: unknown, args: { id: string }) => ({
        __typename: "Invoice",
        id: args.id,
        note: args.id === "bad" ? null : "ok",
      }),
    },
    Invoice: {
      total: (invoice: { id: string }) => {
        if (invoice.id === "bad") {
          throw new Error("total unavailable");
        }
        return 42;
      },
    },
  };
}

test("同一服务两个别名中一侧发生非空错误，另一侧数据保持完整", async () => {
  const pay = makeService("pay", PAY_SDL, payResolvers());
  const gateway = createGateway([pay.config]);

  const query = `
    {
      good: pay {
        invoice(id: "good") { id total note }
      }
      bad: pay {
        invoice(id: "bad") { id total note }
      }
    }
  `;

  const actual = await gateway.execute(query);
  const expected = executeOnComposedSchema({
    services: [{ namespace: "pay", sdl: PAY_SDL, resolvers: payResolvers() }],
    query,
  });

  assert.deepEqual(summarize(actual), summarize(expected));
  assert.deepEqual(actual.data, {
    good: { invoice: { id: "good", total: 42, note: "ok" } },
    bad: { invoice: null },
  });
  assert.deepEqual(
    (actual.errors ?? []).map((error) => ({ message: error.message, path: error.path })),
    [{ message: "total unavailable", path: ["bad", "invoice", "total"] }],
  );

  // 两个别名各自委派一次，委派文档均通过原始 Schema 校验。
  assert.equal(pay.calls.length, 2);
  for (const call of pay.calls) {
    assert.deepEqual(validate(pay.schema, call.document), []);
    assert.doesNotMatch(print(call.document), /pay_/);
  }
});

test("__typename 返回组合类型名，业务字符串与枚举值原样保留，抽象类型判别不依赖显式 __typename", async () => {
  const acct = makeAcctService([]);
  const gateway = createGateway([acct.config]);

  const query = `
    {
      acct {
        invoice(id: "7") {
          id
          tn: __typename
          status
          owner {
            ... on acct_User { name kind }
          }
          lines { description amount }
        }
        search(text: "x") {
          ... on acct_Invoice { number status }
          ... on acct_User { name }
        }
        node {
          name
          ... on acct_User { kind }
        }
      }
    }
  `;

  const actual = await gateway.execute(query);
  const expected = executeOnComposedSchema({
    services: [{ namespace: "acct", sdl: ACCT_SDL, resolvers: acctResolversForReference([]) }],
    query,
  });
  assert.deepEqual(summarize(actual), summarize(expected));

  const data = actual.data as Record<string, any>;
  // __typename（含别名）返回组合类型名。
  assert.equal(data.acct.invoice.tn, "acct_Invoice");
  // 业务字符串恰好等于类型名时原样保留。
  assert.equal(data.acct.invoice.owner.kind, "Invoice");
  assert.equal(data.acct.invoice.lines[0].description, "Invoice");
  // 枚举值不加前缀。
  assert.equal(data.acct.invoice.status, "OPEN");
  // 联合与接口按实际类型选择字段，结果不包含注入的辅助键。
  assert.deepEqual(data.acct.search, [
    { number: "A-s1", status: "PAID" },
    { name: "Ninth" },
  ]);
  assert.deepEqual(data.acct.node, { name: "AcctUser", kind: "User" });
  const json = JSON.stringify(actual.data);
  assert.doesNotMatch(json, /__nsDelegateTypename/);

  // 委派文档有效。
  assert.equal(acct.calls.length, 1);
  assert.deepEqual(validate(acct.schema, acct.calls[0].document), []);
});

test("被指令跳过的服务根响应键不得调用上游", async () => {
  const acct = makeAcctService([]);
  const billing = makeBillingService([]);
  const gateway = createGateway([acct.config, billing.config]);

  const query = `
    query Pick($skipBilling: Boolean!, $includeBilling: Boolean!) {
      a: acct { invoice(id: "1") { id } }
      b: billing @skip(if: $skipBilling) { invoice(id: "1") { id } }
      c: billing @include(if: $includeBilling) { invoice(id: "2") { id } }
    }
  `;

  const actual = await gateway.execute(query, {
    skipBilling: true,
    includeBilling: false,
  });
  assert.deepEqual(actual.data, { a: { invoice: { id: "1" } } });
  assert.equal(actual.errors, undefined);
  assert.equal(acct.calls.length, 1);
  assert.equal(billing.calls.length, 0);
});

test("服务根结果为空时不抹掉其他顶层响应键，同一上游错误不重复", async () => {
  const flaky = makeService("flaky", `type Query { boom: String! }`, {
    Query: {
      boom: () => {
        throw new Error("root exploded");
      },
    },
  });
  const acct = makeAcctService([]);
  const gateway = createGateway([flaky.config, acct.config]);

  const query = `
    {
      f1: flaky { boom }
      a: acct { invoice(id: "1") { id number } }
      f2: flaky { boom }
    }
  `;

  const actual = await gateway.execute(query);
  const data = actual.data as Record<string, unknown>;
  assert.equal(data.f1, null);
  assert.equal(data.f2, null);
  assert.deepEqual(data.a, { invoice: { id: "1", number: "A-1" } });
  const errors = (actual.errors ?? []).map((error) => ({
    message: error.message,
    path: error.path,
  }));
  assert.deepEqual(errors, [
    { message: "root exploded", path: ["f1", "boom"] },
    { message: "root exploded", path: ["f2", "boom"] },
  ]);
  const unique = new Set(errors.map((error) => JSON.stringify(error)));
  assert.equal(unique.size, errors.length);
});

test("递归类型与同名响应键的字段合并", async () => {
  const TREE_SDL = `
type Query {
  category(id: ID!): Category
}
type Category {
  id: ID!
  label: String!
  parent: Category
  children: [Category!]!
}
`;
  const category = (id: string, parent: unknown = null): Record<string, unknown> => ({
    __typename: "Category",
    id,
    label: `cat-${id}`,
    parent,
    children: id === "1" ? [category("2"), category("3")] : [],
  });
  const treeResolvers = () => ({
    Query: {
      category: (_source: unknown, args: { id: string }) => category(args.id),
    },
  });
  const tree = makeService("tree", TREE_SDL, treeResolvers());
  const gateway = createGateway([tree.config]);

  const query = `
    {
      t: tree {
        category(id: "1") { id label }
      }
      t: tree {
        category(id: "1") {
          children { id label children { id } }
          parent { id }
        }
      }
    }
  `;

  const actual = await gateway.execute(query);
  const expected = executeOnComposedSchema({
    services: [{ namespace: "tree", sdl: TREE_SDL, resolvers: treeResolvers() }],
    query,
  });
  assert.deepEqual(summarize(actual), summarize(expected));
  assert.deepEqual(actual.data, {
    t: {
      category: {
        id: "1",
        label: "cat-1",
        children: [
          { id: "2", label: "cat-2", children: [] },
          { id: "3", label: "cat-3", children: [] },
        ],
        parent: null,
      },
    },
  });
  // 同一响应键合并为一次委派。
  assert.equal(tree.calls.length, 1);
  assert.deepEqual(validate(tree.schema, tree.calls[0].document), []);
});

test("多操作文档按 operationName 执行", async () => {
  const acct = makeAcctService([]);
  const gateway = createGateway([acct.config]);
  const document = `
    query One { acct { invoice(id: "1") { id } } }
    query Two { acct { user(id: "u1") { id name } } }
  `;
  const actual = await gateway.execute(document, {}, "Two");
  assert.deepEqual(actual.data, { acct: { user: { id: "u1", name: "AcctUser" } } });
  assert.equal(acct.calls.length, 1);
});
