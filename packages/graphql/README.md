@drfed/graphql
==============

GraphQL server for [DrFed], built with [Pothos] and [GraphQL Yoga].  Exposes
a Relay-compatible schema backed by Drizzle ORM.

[DrFed]: https://drfed.org/
[Pothos]: https://pothos-graphql.dev/
[GraphQL Yoga]: https://the-guild.dev/graphql/yoga-server


Scalars
-------

| Scalar     | Description               |
| ---------- | ------------------------- |
| `DateTime` | ISO 8601 timestamp        |
| `Email`    | Normalized e-mail address |
| `UUID`     | RFC 4122 UUID             |


Usage
-----

~~~~ ts
import { createYogaServer } from "@drfed/graphql";
import createFederation from "@drfed/graphql/federation";

const federation = await createFederation(db, { kv });
const yoga = createYogaServer(db, federation);
serve({
  fetch: (request) =>
    federation.fetch(request, { onNotFound: yoga.fetch, contextData: undefined }),
});
~~~~

`createFederation` builds a Fedify `Federation` with every DrFed dispatcher
registered.  `createYogaServer` accepts a Drizzle database instance, that
federation, and optional server options, and returns a GraphQL Yoga server
ready to handle HTTP requests.  The federation is stored in the resolver
context as is; `createYogaServer` never registers anything on it.
