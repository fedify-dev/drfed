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
import createFederation from "@drfed/federation";
import { createYogaServer } from "@drfed/graphql";

const federation = await createFederation(db, { kv });
const yoga = createYogaServer(db, federation, {
  rootOrigin,
  loginOrigins: new Set(["https://drfed.example.com"]),
});
// For a dedicated GraphQL listener; the application CLI owns combined routing.
serve({ fetch: yoga.fetch });
~~~~

`createFederation`, from [`@drfed/federation`], builds a Fedify `Federation`
with every DrFed dispatcher registered.  `createYogaServer` accepts a Drizzle
database instance, that federation, and server options, and returns a GraphQL
Yoga server ready to handle HTTP requests.  The federation is stored in the
resolver context as is; `createYogaServer` never registers anything on it.

The installed `drfed-server` routes only the exact `/graphql` path to Yoga.
Combined mode injects `yoga.fetch` directly into the web runtime; `drfed-web`
uses a configured backend origin over HTTP. Both bridges promote only a
validated session token to Bearer authentication. Federation requests never
fall back to GraphQL or the frontend. See the
[CLI documentation](../drfed/README.md) for combined and `--no-web` deployments.

[`@drfed/federation`]: https://github.com/fedify-dev/drfed/tree/main/packages/federation


Reading activities and objects
------------------------------

Activities and objects of local actors are readable by anyone, whatever their
addressing, since they are what DrFed's users make to debug with.  What
remote actors sent is an inbox's content, which [ActivityPub] filters by the
requester's permission (section 5.2) and opens without authentication only
when addressed to the public (section 5.6):

 -  An activity of a remote actor is readable when it is addressed to the
    public, or by an accepted member of a local instance that received it,
    i.e. one of whose accepted inbound deliveries is linked to it and carried
    it as stored.  A delivery of the same activity IRI with other contents
    stays linked for debugging, but grants nothing.
 -  An object of a remote actor is readable when it is addressed to the
    public, when the activity it was received in is, or by an accepted member
    of a local instance that received that activity and the object as stored
    with it.  When the object was fetched apart from the activity, only a
    delivery whose inbox listener fetched it as stored received it so, since
    it may differ from fetch to fetch.
 -  Administrators read everything.

`as:Public` and `Public` count as the public as well as its full IRI.  What the
viewer may not read is left out as if it did not exist: `node` and `nodes`
return null for it, as do `Resource.detail` and `Activity.object`, and
`Actor.objects`, `Object.activities`, and `Collection.items` leave it out
before paging, so that neither cursors nor `totalCount` tell of it.

[ActivityPub]: https://www.w3.org/TR/activitypub/


Login mail and shutdown
-----------------------

`loginByEmail` returns a challenge ID for both known and unknown accounts.
A failed mail receipt or a provider exception keeps this response unchanged;
operators receive a fixed outcome diagnostic without provider error text or
message IDs. Users can request another link if mail does not arrive.

For shutdown integration when embedding Yoga, see
[runtime ownership](#runtime-ownership).


Activity deliveries
-------------------

`Instance.activityDeliveries` and `Actor.activityDeliveries` expose delivery
observations, newest first, with direction, status, and type filters.  Only
accepted local instance members and site administrators can read them,
including through Relay node IDs.  `Actor.activityDeliveries` lists the
deliveries that arrived at the actor's inbox, that the actor sent, and that are
addressed to the actor through any inbox, the shared one included.  Addressing
through a collection counts as far as DrFed has stored the collection's
members.  Each of its edges tells how the delivery concerns the actor:
`inboxOwner`, `sender`, `addressed`, `addressedDirectly` when the activity
named the actor itself, and `viaCollections`, every addressed collection the
actor was a member of when the delivery arrived, so that a shared-inbox
delivery, whose `actor` is null, still explains why it is in the actor's feed.
`ActivityDelivery.attempts` is a connection, oldest attempt first.

`ActivityDelivery.activity` is the stored activity a delivery is linked to,
and `Activity.deliveries` lists an activity's deliveries, newest first.  Since
one activity's deliveries span instances, `Activity.deliveries` leaves out,
before paging, those of instances the viewer may not read, rather than failing
on them.

`KeyVersion.firstSeen` and `lastSeen` are DrFed observation times, not remote
rotation times or evidence of continuous use.  `Key` and `KeyVersion` hold
public material only and are readable by any authenticated viewer.

Recording requires the federation recorder and outbound delivery wrapper. See
[activity delivery internals] for the raw request fields,
verification and status semantics, key observations, and queued delivery
attempts. The [inbox persistence internals]
explain how accepted deliveries acquire stored resources.

[activity delivery internals]: https://drfed.org/internals/activity-deliveries
[inbox persistence internals]: https://drfed.org/internals/inbox-persistence


Moved exports
-------------

The ActivityPub code that used to live in this package moved to
[`@drfed/federation`], which does not depend on GraphQL:

| Previous import                                        | Replacement                           |
| ------------------------------------------------------ | ------------------------------------- |
| `@drfed/graphql/federation` (factory functions)        | `@drfed/federation`                   |
| `@drfed/graphql/federation` (selections, serializers)  | `@drfed/federation/object`            |
| `@drfed/graphql/origin`                                | `@drfed/federation/origin`            |
| `@drfed/graphql/activity-delivery` (runtime functions) | `@drfed/federation/activity-delivery` |

`@drfed/graphql/activity-delivery` now holds only the GraphQL types for
activity deliveries.


Generating the schema
---------------------

Run `mise run generate:graphql-schema --output-file schema.graphql` from the
repository root.  This task builds models, federation, and GraphQL through
`build:backend`, then imports the built schema directly.  It does not build
the application CLI or frontend, so frontend compilation can use it without
creating a dependency cycle.  Omitting `--output-file` writes to stdout.

The installed `drfed-server --generate-graphql-schema` option remains available
for users who need the schema from their installed version.


Runtime ownership
-----------------

When embedding `createYogaServer()`, pass `shutdownSignal` and `trackOperation`
if the runtime closes database or mail resources on shutdown. Cancellation
alone does not mean resolver work has stopped. See [runtime lifecycle internals]
for context loading, resolver tracking, the callback contract and draining
order.

[runtime lifecycle internals]: https://drfed.org/internals/runtime-lifecycle
