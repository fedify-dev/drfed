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


Exports
-------

| Import                                | Contents                                                     |
| ------------------------------------- | ------------------------------------------------------------ |
| `@drfed/federation`                   | `createFederation()` (default), `buildFederation()`          |
| `@drfed/federation/activity-delivery` | Inbound recording, outbound delivery, and their observations |
| `@drfed/federation/object`            | Query selections, `toObject()`, and `toCreate()`             |
| `@drfed/federation/origin`            | `instanceHost()`, `classifyHost()`, and other host helpers   |

The serializers in `@drfed/federation/object` are the same ones the
dispatchers use, so documents stored by GraphQL mutations match what is served
over ActivityPub.  Load rows with the matching selection before serializing
them.


Activity deliveries
-------------------

`createFederation()` captures Fedify's inbox completion reports and tracks
outbound spans and measurements.  It observes the outbox queue when one is
given, so that each delivery
can be recorded in `activity_deliveries`.  Wrap the federation's HTTP surface
with `createInboundRecorder()` to record every inbox request, and send
activities with `deliverActivity()`.  Both are also exported from the package
root.  The GraphQL fields that read these records are documented in
[`@drfed/graphql`].

[`@drfed/graphql`]: https://github.com/fedify-dev/drfed/tree/main/packages/graphql


Received activities
-------------------

The inbox listeners store a received `Create` in `activities`, with its remote
actor and object, when:

 -  it has an ID, and its actor is not a local actor, whose activities DrFed
    stores as it sends them;
 -  its object is a `Note` or an `Article` with an ID on the origin of the
    actor, attributed to the actor, and with content, as [FEP-fe34] requires
    of an object its actor creates;
 -  its actor has an inbox;
 -  its text holds neither U+0000 nor an unpaired surrogate, which PostgreSQL
    would refuse or alter; the delivery keeps such text as received; and
 -  `createInboundRecorder()` recorded the request, which tells the listener
    what the request carried and when it arrived.

An IRI already stored is kept as it is: a `Create` received again, or by
several instances, is stored once, and nothing it carries is written then, even
an object it names anew.  One that claims another actor's object or an IRI of
another kind is not stored.  The activity and its embedded object are stored as
received, whatever terms their context uses.
A remote actor's `username` is its `preferredUsername`, which may be missing.

Fedify authenticates an activity before answering it with 2xx, so every
inbound delivery that was verified and answered with 2xx is linked to the
stored activity its ID names, a duplicate Fedify skips included.  An outbound
delivery is linked to the activity it sends.

[FEP-fe34]: https://w3id.org/fep/fe34


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
