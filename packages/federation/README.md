@drfed/federation
=================

ActivityPub federation for [DrFed], built with [Fedify].  Registers the
dispatchers and inbox listeners that serve local actors, objects, activities,
and collections, serializes stored objects and activities into ActivityPub
vocabulary, and owns the rules for composing and recognizing instance hosts.

This package depends on `@drfed/models` but not on `@drfed/graphql`, so
serving ActivityPub never requires a GraphQL schema.

[DrFed]: https://drfed.org/
[Fedify]: https://fedify.dev/


Usage
-----

~~~~ ts
import createFederation from "@drfed/federation";

const federation = await createFederation(db, { kv });
~~~~

`createFederation()` creates a fresh builder with every DrFed dispatcher and
listener registered on it, then builds it with the given Fedify options.  Each
call returns an independent `Federation` that resolves local actors from the
given database.  `buildFederation(db)` returns the builder without building
it, for callers that build it themselves.

The CLI routes instance subdomains to this federation. See
[HTTP serving internals] for authority classification and the
[CLI documentation](../drfed/README.md#root-origin) for reverse proxy setup.

[HTTP serving internals]: https://drfed.org/internals/http-serving


Exports
-------

| Import                                | Contents                                                      |
| ------------------------------------- | ------------------------------------------------------------- |
| `@drfed/federation`                   | `createFederation()` (default), `buildFederation()`           |
| `@drfed/federation/activity-delivery` | Inbound recording, outbound delivery, and their observations  |
| `@drfed/federation/actor-key`         | `ensureActorKeyPairs()` for persisted actor signing keys      |
| `@drfed/federation/task-queue`        | `KeyGenerationQueue` for background actor key generation      |
| `@drfed/federation/local-write`       | Common write operations that save, edit, and delete resources |
| `@drfed/federation/object`            | Query selections, `toObject()`, and `toCreate()`              |
| `@drfed/federation/origin`            | `instanceHost()`, `classifyHost()`, and other host helpers    |
| `@drfed/federation/serving`           | Serialization of saved documents for public output            |

The serializers in `@drfed/federation/object` are the same ones the
dispatchers use, so documents stored by GraphQL mutations match what is served
over ActivityPub.  Load rows with the matching selection before serializing
them.


Local writes
------------

`previewLocalWrite()` and `commitLocalWrite()` from
`@drfed/federation/local-write` save local resources for editors: an object
alone, an activity referring to existing resources, or an activity with new
nested resources, atomically, and actual edits or deletions of a current
object with a generated `Update` or `Delete`.  A preview shows every value the
server adds and returns a token; the commit saves exactly those values after
checking permission again.  Saving never delivers anything.  See the
[local write internals] for the contract.

[local write internals]: https://drfed.org/internals/local-writes


Federation reads
----------------

The dispatchers serve legacy `Note`/`Article` objects and `Create` activities
from their typed rows, and resources saved by the common write operations from
their current documents, without blind recipients.  `publicDocument()` from
`@drfed/federation/serving` is the same serialization, for outgoing payloads
to share, and `parseVocab()` parses its result into a Fedify vocabulary
object.  See [federation read internals] for what is served where.

[federation read internals]: https://drfed.org/internals/federation-reads


Activity deliveries
-------------------

Wrap the HTTP surface of a federation made by `createFederation()` with
`createInboundRecorder()`, and send activities with `deliverActivity()`. Both
are exported from the package root and `@drfed/federation/activity-delivery`.
See [activity delivery internals] for completion reports,
queue observations and storage, and the
[GraphQL package README](../graphql/README.md#activity-deliveries) for query
fields and access rules.

[activity delivery internals]: https://drfed.org/internals/activity-deliveries


Received activities
-------------------

See [inbox persistence internals] for received `Create`
acceptance, idempotence, original document retention and links to deliveries
and resource revisions.

[inbox persistence internals]: https://drfed.org/internals/inbox-persistence


Signing key recovery
--------------------

Invalid JWKs in `local_actor_keys` cause key loading to fail.  DrFed does not
replace them automatically, since doing so would change the actor's published
keys.

Stop the server and back up the database before repairing a row.  Restore the
matching public/private JWK pair from a known-good backup, keeping its
`local_actor_id` and `type`.  Restart and fetch the actor document to confirm
that `publicKey` and `assertionMethods` publish the expected keys.

If the original pair cannot be recovered, replacing it is an explicit key
rotation.  DrFed has no rotation command or remote-cache invalidation workflow.
Before resuming signing, an operator must deliberately install and validate a
matching replacement pair for the same key type and verify the updated actor
document.  Remote servers may still cache the old public key; plan for that
transition.  Do not delete the row merely to trigger first-use generation.


Logging
-------

Inbox activity is logged under the `["drfed", "federation"]` category, and
activity delivery recording under
`["drfed", "federation", "activity-delivery"]`.
