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
import createFederation, { createInboundRecorder } from "@drfed/federation";
import { createYogaServer } from "@drfed/graphql";

const federation = await createFederation(db, { kv });
const recordedInbox = createInboundRecorder({ db, federation, rootOrigin });
const yoga = createYogaServer(db, federation, {
  loginOrigins: new Set(["https://drfed.example.com"]),
});
serve({
  fetch: (request) =>
    recordedInbox.fetch(request, { onNotFound: yoga.fetch, contextData: undefined }),
});
~~~~

`createFederation`, from [`@drfed/federation`], builds a Fedify `Federation`
with every DrFed dispatcher registered.  `createYogaServer` accepts a Drizzle
database instance, that federation, and server options, and returns a GraphQL
Yoga server ready to handle HTTP requests.  The federation is stored in the
resolver context as is; `createYogaServer` never registers anything on it.

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
    i.e. one of whose accepted inbound deliveries is linked to it.
 -  An object of a remote actor is readable when it is addressed to the
    public, or when the viewer may read the activity it was received in.
 -  Administrators read everything.

`as:Public` and `Public` count as the public as well as its full IRI.  What the
viewer may not read is left out as if it did not exist: `node` and `nodes`
return null for it, as do `Resource.detail` and `Activity.object`, and
`Actor.objects`, `Object.activities`, and `Collection.items` leave it out
before paging, so that neither cursors nor `totalCount` tell of it.

[ActivityPub]: https://www.w3.org/TR/activitypub/


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

Wrap the federation HTTP surface with `createInboundRecorder` from
[`@drfed/federation`], passing a federation made by `createFederation` from
the same package and the root origin.  Every inbox `POST`
is recorded, whether or not its body is JSON; recording errors never replace
federation responses.  A request Fedify throws on is recorded too, with the
exception in `error` and no `statusCode`, and the exception is thrown again.
An inbound delivery keeps:

 -  The request as received: `rawBody` (or `rawBodyBase64` when the body is not
    valid UTF-8), `requestHeaders`, and `requestUrl`.  `payload` is the body
    parsed as JSON for querying, and is `null` when it does not parse or
    holds U+0000 or an unpaired surrogate, which PostgreSQL cannot store.
    `cookie` headers are dropped, and `authorization` is kept only for the
    `Signature` scheme.
 -  `inboxUrl`, the canonical IRI of the inbox, however the request spelled its
    host or scheme.
 -  `verificationMechanism` and `verificationResult` summarize Fedify's
    `onRequestFinished()` report, independently of OpenTelemetry sampling.
    DrFed verifies nothing again.  The result is `unattempted` when no
    signature check ran before a preparation or parsing failure, and
    `unobserved` when the report is missing or observation fails.
 -  The report can contain several attempts and keys; the delivery retains
    one representative check.  Root activity evaluations take precedence over
    embedded portable objects.  An authenticating attempt wins, followed by
    the last cryptographically successful evaluation, including an attribution
    refusal, then the last meaningful failed evaluation.  A partly invalid
    proof set remains `invalid_signature` or `key_fetch_error`.
 -  `key_fetch_error` comes from an explicit fetch failure.  `error` includes
    `keyFetchError:` and the HTTP status or the original error's name and
    message, including for cached failures.  A document with no usable key
    that Fedify reports as `invalidSignature` is `invalid_signature`.
 -  A valid signature or proof can still fail authentication.  Linked Data
    Signatures with the wrong owner and Object Integrity Proofs with uncovered
    attributions remain `verified` with `status` `rejected`.  `error` records
    Fedify's attribution, ownership, nonce or proof-policy reason.  Other
    refusals and processing failures use the completion report's reason;
    exceptions retain the original thrown value's description.
 -  `verificationKey` is the actual successful key of the selected check, or
    its last tried key on failure, including when refreshing a cached key
    fails.  Its history uses the key snapshot's ID, falling back to a valid
    declared key ID when the snapshot has none.  `signedKeyIri` is the HTTP
    signature's declaration, preferring the successful check when several
    HTTP signatures were evaluated.  It may differ from the history ID or
    refer to a mechanism that did not authenticate the request.  Malformed
    declarations remain in the raw request.
 -  `status`, which follows the response Fedify gave: `received` when the inbox
    listener ran, `acknowledged` when the request was answered 2xx without it
    (a duplicate, for instance), `rejected` when a verified activity was
    refused or its handling threw, and `unverified` otherwise.  With an inbox
    queue, a delivery is
    `acknowledged` when the request is answered and becomes `received` once the
    queue worker runs the listener; the queued message carries its delivery ID.

`KeyVersion.firstSeen` and `lastSeen` are DrFed observation times, not remote
rotation times or evidence of continuous use.  `Key` and `KeyVersion` hold
public material only and are readable by any authenticated viewer.

`deliverActivity`, also from [`@drfed/federation`], is the outbound entry point
for explicit recipients once local actor keys are available (#87).  It removes
`bto` and `bcc` before delivery, records one row per destination inbox with
every recipient sharing it in `recipientIris`, and settles each delivery
independently.  A recipient without an ID or an inbox is left out, because
Fedify does not deliver to it. The recorded `payload` is the document before
signing.  `attempts` keeps every attempt that ended, with the status the remote
inbox answered, read from the responses `fetch()` publishes on
`diagnostics_channel`, and the causes of network errors.  When the inbox
redirects a delivery, the status is the one the redirects ended with, whether
Fedify followed them, as it does when it signs the request, or `fetch()` did.
With a message queue, `createFederation` observes Fedify's outbox worker, and
each queued message carries the delivery it belongs to.  A delivery becomes
`sent` when Fedify reports `activitypub.activity.sent` for its inbox, stays
`failed` while it is retried, and ends `permanently_failed`, or `abandoned`
when Fedify measures it abandoned after its retries ran out.  A delivery Fedify
returns from without sending to the inbox, or without enqueuing a message to
it, is `permanently_failed` with no attempt, since Fedify makes none.  The
queue is handed to Fedify as one without native retries, so that every retry
follows Fedify's policy and is recorded.  Activity resource persistence (#88),
retention policies, and the activity-log UI (#13) are separate.

URL fields hold only values that parse as URLs, and no text field holds
U+0000; anything else a remote server sent stays in `rawBody` and
`requestHeaders`, and in `payload` when PostgreSQL can store it.  `error` and
`responseBody` keep what a remote server answered with U+FFFD for each U+0000.
Deliveries are ordered by `created`, which for an inbound delivery is when the
request arrived; `completed` is when DrFed answered it.


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
