# graphql-namespace-delegation

In-memory GraphQL namespace delegation library. Multiple upstream services may
define identically named types (e.g. `Invoice`, `User`); the gateway composes
them behind a single `Query` root where each namespace is a nullable field, and
delegates sub-queries back to each service's own schema so upstream semantics
stay intact.

## Usage

```ts
import { createNamespaceGateway } from "graphql-namespace-delegation";

const gateway = createNamespaceGateway([
  {
    namespace: "billing",
    sdl: `type Query { invoice: Invoice } type Invoice { id: ID! }`,
    execute: (document, variables) => myBillingExecutor(document, variables),
  },
]);

const result = await gateway.execute(
  `{ billing { invoice { __typename id } } }`,
  {},
);
// __typename === "billing_Invoice"
```

- Every named type of a service (including its query root) is exposed as
  `Namespace_OriginalName`; built-in scalars, field/argument/input-field/enum
  names are unchanged.
- The executor callback receives a `DocumentNode` validated against the
  service's own schema plus the subset of variables it actually uses
  (defaults preserved).
- `__typename` in responses is rewritten to the composed name (aliases
  included); business strings, IDs and enum values are never rewritten.
- Upstream error messages are preserved and paths are re-rooted to the full
  composed response path; non-null propagation follows the composed schema.

## Develop

```sh
npm install
npm test
```
