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

`createFederation()` tracks the public keys, spans, and measurements Fedify
reports, and observes the outbox queue when one is given, so that each delivery
can be recorded in `activity_deliveries`.  Wrap the federation's HTTP surface
with `createInboundRecorder()` to record every inbox request, and send
activities with `deliverActivity()`.  Both are also exported from the package
root.  The GraphQL fields that read these records are documented in
[`@drfed/graphql`].

[`@drfed/graphql`]: https://github.com/fedify-dev/drfed/tree/main/packages/graphql


Logging
-------

Inbox activity is logged under the `["drfed", "federation"]` category, and
activity delivery recording under
`["drfed", "federation", "activity-delivery"]`.
