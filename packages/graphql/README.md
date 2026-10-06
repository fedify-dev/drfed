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
const recordedInbox = createInboundRecorder({ db, federation, rootOrigin });
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

Wrap the federation HTTP surface with `createInboundRecorder`, passing a
federation made by `createFederation` and the root origin.  Every inbox `POST`
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
 -  `verificationMechanism` and `verificationResult`, what Fedify reported of
    verifying the request, as its OpenTelemetry manual documents: the
    `activitypub.signature.verification.duration` result of each mechanism it
    tried, the `activitypub.signature.key_fetch.duration` and
    `activitypub.key.lookup` results of the keys it fetched for each, the
    `*.verify` spans naming their keys, and the
    `activitypub.activity.received` event.  DrFed verifies nothing again.  The
    result is `unattempted` when Fedify answered before verifying, such as for
    a body that is not JSON or an inbox whose owner does not exist, even if
    the body carries a signature or proof.  Proofs are found as JSON-LD,
    however `proof` is spelled.
 -  A refusal is `key_fetch_error` rather than `invalid_signature` when the
    last key fetch of the mechanism brought no usable key, whichever
    mechanism it is: the signature was then not checked, or only against a
    cached key that did not verify.  `error` tells why as `keyFetchError:`
    followed by the status the server of the key answered with, by `cached`
    for the record of an earlier failure, or by the lookup result Fedify
    counted, such as `network_error` or `invalid` for a document that holds no
    key.  When Fedify itself names the fetch of an HTTP signature's key as
    failed, what follows is the status or the type of the error it reports.
 -  The result tells whether a signature or proof verified, not whether it
    authenticated the activity.  Object Integrity Proofs that verify without
    their keys' controllers covering the activity's actor are `verified`, and
    the refusal is `status` `rejected`, with `error` telling that Fedify did
    not accept them, even when the HTTP signature Fedify went on to failed.
    Fedify reports a Linked Data Signature that verifies without its key's
    owner being the actor the same as one that does not verify, so that one
    is `invalid_signature`.
 -  `verificationKey`, the public key version that mechanism used, even when
    verification failed: the last key its cache entry held during a key fetch
    of that one verification which brought a key, whether read or fetched,
    even when fetching it again then failed.  A key another mechanism of the
    same request found under the same IRI is not it, nor is one read from the
    cache that the verification could not use.  `signedKeyIri` is the `keyId`
    the HTTP signature declares.  The two may name different keys.
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

`deliverActivity` is the outbound entry point for explicit recipients once
local actor keys are available (#87).  It removes `bto` and `bcc` before
delivery, records one row per destination inbox with every recipient sharing
it in `recipientIris`, and settles each delivery independently.  A recipient
without an ID or an inbox is left out, because Fedify does not deliver to it.
The recorded `payload` is the document before signing.  `attempts` keeps every
attempt that ended, with the status the remote inbox answered, read from the
responses `fetch()` publishes on `diagnostics_channel`, and the causes of
network errors.  When the inbox redirects a delivery, the status is the one
the redirects ended with, whether Fedify followed them, as it does when it
signs the request, or `fetch()` did.  With a message queue, `createFederation`
observes Fedify's outbox worker, and each queued message carries the delivery
it belongs to.  A delivery becomes `sent` when Fedify reports
`activitypub.activity.sent` for its inbox, stays `failed` while it is retried,
and ends `permanently_failed`, or `abandoned` when Fedify measures it abandoned
after its retries ran out.  A delivery Fedify returns from without sending to
the inbox, or without enqueuing a message to it, is `permanently_failed` with
no attempt, since Fedify makes none.  The queue is handed to Fedify as one
without native retries, so that every retry follows Fedify's policy and is
recorded.  Activity resource persistence (#88),
retention policies, and the activity-log UI (#13) are separate.

URL fields hold only values that parse as URLs, and no text field holds
U+0000; anything else a remote server sent stays in `rawBody` and
`requestHeaders`, and in `payload` when PostgreSQL can store it.  `error` and
`responseBody` keep what a remote server answered with U+FFFD for each U+0000.
Deliveries are ordered by `created`, which for an inbound delivery is when the
request arrived; `completed` is when DrFed answered it.
