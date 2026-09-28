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
import createFederation, { createInboundRecorder } from "@drfed/graphql/federation";

const federation = await createFederation(db, { kv });
const recordedInbox = createInboundRecorder({ db, federation, kv });
const yoga = createYogaServer(db, federation, {
  loginOrigins: new Set(["https://drfed.example.com"]),
});
serve({
  fetch: (request) =>
    recordedInbox.fetch(request, { onNotFound: yoga.fetch, contextData: undefined }),
});
~~~~

`createFederation` builds a Fedify `Federation` with every DrFed dispatcher
registered.  `createYogaServer` accepts a Drizzle database instance, that
federation, and server options, and returns a GraphQL Yoga server
ready to handle HTTP requests.  The federation is stored in the resolver
context as is; `createYogaServer` never registers anything on it.


Activity logs
-------------

`Instance.activityLogs` and `Actor.activityLogs` expose delivery observations,
newest first, with direction, status, and type filters. Only accepted local
instance members and site administrators can read them, including through
Relay node IDs. Payloads may contain unverified input and private recipients.
A literal JSON `null` body is retained and exposed as a nullable `payload`.

`ActivityLog.verificationKey` retains the observed public key version even
when verification failed. `KeyVersion.firstSeen` and `lastSeen` are DrFed
observation times, not remote rotation times or evidence of continuous use.

Wrap the federation HTTP surface with `createInboundRecorder` using the same
KV store (and public-key prefix when customized). JSON inbox POSTs are logged;
non-JSON bodies are excluded. Logging errors never replace federation responses.

`deliverActivity` is the outbound entry point for explicit recipients once
local actor keys are available (#87). It records one row per destination inbox
and settles each synchronous delivery independently. `createFederation` rejects
queues until Fedify exposes delivery success callbacks. Activity resource
persistence (#88), retention policies, and the activity-log UI (#13) are
separate.
