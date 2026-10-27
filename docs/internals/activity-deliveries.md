Activity deliveries
===================

Delivery observations describe transport and verification, independently of
ActivityPub resource history. This page connects the model records, Fedify
completion reports and queue workers. The [GraphQL package README]
describes the query fields and who may read them.

[GraphQL package README]: https://github.com/fedify-dev/drfed/tree/main/packages/graphql#activity-deliveries


Activity delivery storage
-------------------------

`activity_deliveries` stores delivery observations separately from ActivityPub
`activities`.  `@drfed/models/activity-delivery` exposes `recordInbound`,
`receiveInbound`, `recordOutbound`, and `settleOutbound`.  `receiveInbound`
marks an `acknowledged` inbound delivery `received` once a queued inbox
listener ran.  An inbound delivery keeps the received
octets in `body` and the request headers in `headers`; `payload` is the body
parsed as JSON, and is SQL `NULL` when it does not parse or holds U+0000 or an
unpaired surrogate, which `jsonb` cannot store.  `error` and `response_body`
are stored with U+FFFD for each U+0000, which text cannot store, so that a
remote response never keeps a delivery from being written.  `created` is when
a request arrived or a delivery started, and `completed` when DrFed answered
the request or the delivery last changed status.

`settleOutbound` settles the most recent pending (`queued` or `failed`)
delivery to an inbox and never changes a `sent`, `permanently_failed`, or
`abandoned` one.  Each attempt that ends is kept in
`activity_delivery_attempts`, so a retry never rewrites the outcome of an
earlier attempt.

`activity_id` links a delivery to the stored activity it carried.
`linkInboundActivity` links an inbound delivery only when it was verified and
answered with 2xx, by the activity IRI it recorded; `recordOutbound` takes the
`activityId` of the activity it sends.  `recordInbound` does not take one, and
a CHECK constraint refuses a linked inbound delivery that is not verified,
`received` or `acknowledged`.  A delivery outlives its activity.
`carried_snapshot` marks an inbound delivery whose payload is the stored
activity's document. `carried_object_snapshot` marks one that also carried the
object as stored with that activity. The object must have been taken from the
activity, or `objects.fetched` must be true and the delivery's `fetched_object`
must match the stored document. That field records what the inbox listener
fetched. Neither record function
takes a mark; `linkInboundActivity` decides both anew on every link, and
`recordFetchedObject` again for a delivery linked before its listener ran, so
that a mark left from a deleted activity never carries over to another stored
under the same IRI.

`activity_delivery_actors` relates a delivery to each local actor it concerns,
as the owner of the inbox, as an addressed recipient, or as the sender, with
one row per delivery and actor.  An addressed actor keeps every way it was
addressed: `addressed_directly` when the activity named the actor itself, and
a row in `activity_delivery_actor_collections` for each addressed collection
it was a member of.  Each row copies the delivery's `created`, by which an
actor's deliveries are ordered.  Both record functions insert these rows in
the same transaction as the delivery.  They record nothing and throw when the
inbox owner, the sender, or an addressed actor is not a local actor of the
delivery's instance. The foreign keys alone do not enforce this instance
membership.

`@drfed/models/key` exposes public-JWK validation, RFC 7638/RFC 8037 SHA-256
thumbprints, and `observeKeyVersion`.  `keys` identifies each exact key IRI;
`key_versions` retains immutable public material per fingerprint.  Returning to
an earlier key reuses its version.  Observation timestamps do not describe
remote rotation times or continuous use.  Deliveries retain referenced versions
with `ON DELETE RESTRICT`, independently of Fedify cache expiry.


Federation observations
-----------------------

Wrap the federation HTTP surface with `createInboundRecorder` from
`@drfed/federation`, passing a federation made by `createFederation` from
the same package and the root origin.  Every inbox `POST`
is recorded, whether or not its body is JSON; recording errors never replace
federation responses.  A request Fedify throws on is recorded too, with the
exception in `error` and no `statusCode`, and the exception is thrown again.
The following names are GraphQL fields; the storage section above uses database
column names. An inbound delivery exposes:

 -  The request as received: `rawBody` (or `rawBodyBase64` when the body is not
    valid UTF-8), `requestHeaders`, and `requestUrl`. `payload` follows the
    parsing and `jsonb` storage rules above and exposes SQL `NULL` as `null`.
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
    fails.  The stored key history uses the key snapshot's ID, falling back to
    a valid declared key ID when the snapshot has none.  `signedKeyIri` is the
    HTTP signature's declaration, preferring the successful check when several
    HTTP signatures were evaluated.  It may differ from the history ID or refer
    to a mechanism that did not authenticate the request.  Malformed
    declarations remain in the raw request.
 -  `status`, which follows the response Fedify gave: `received` when the inbox
    listener ran, `acknowledged` when the request was answered 2xx without it
    (a duplicate, for instance), `rejected` when a verified activity was
    refused or its handling threw, and `unverified` otherwise.  With an inbox
    queue, a delivery is
    `acknowledged` when the request is answered and becomes `received` once the
    queue worker runs the listener; the queued message carries its delivery ID.

`deliverActivity`, also from `@drfed/federation`, is the outbound entry point
for explicit recipients once local actor keys are available.  It removes
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
follows Fedify's policy and is recorded.  Activity resources and delivery
observations have separate lifetimes; see
[resource revisions](resource-revisions.md) for retained resource history.

URL fields hold only values that parse as URLs, and no text field holds
U+0000; anything else a remote server sent stays in `rawBody` and
`requestHeaders`, and in `payload` when `jsonb` can store it. `responseBody`
exposes the sanitized `response_body` column described above. Deliveries are
ordered by `created`.

The [inbox persistence path](inbox-persistence.md) stores accepted resources.
A delivery link alone does not prove that its payload matches a retained
snapshot; the receipt marks above preserve that distinction.
Shutdown must drain listeners and workers before closing their database; see
[runtime lifecycle](runtime-lifecycle.md).
