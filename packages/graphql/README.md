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

const yoga = createYogaServer(db);
serve({ fetch: yoga.fetch.bind(yoga) });
~~~~

`createYogaServer` accepts a Drizzle database instance and returns a
GraphQL Yoga server ready to handle HTTP requests.
