Local writes
============

This page is for contributors writing editors, mutations or delivery code that
save local resources. It describes the common write operations in
`@drfed/federation/local-write` and the contracts their callers must keep.

The operations build on [resource revisions](resource-revisions.md) for
storage and on the shared validator in `@drfed/models/document` for document
checks. The decisions they implement are recorded on [#149] and in its
[follow-up for #152].

[#149]: https://github.com/fedify-dev/drfed/issues/149
[follow-up for #152]: https://github.com/fedify-dev/drfed/issues/149#issuecomment-6569025455


Operations
----------

| Operation | What a commit does                                                                                       | Outbox                    |
| --------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| `create`  | Saves new resources: an object alone, an activity, or an activity with new nested objects or activities. | Only with `publish: true` |
| `edit`    | Appends a current object's new version and saves a generated `Update` embedding it.                      | The `Update`              |
| `delete`  | Appends a whiteout for a current object and saves a generated `Delete` that refers to it.                | The `Delete`              |

Saving never delivers anything. An activity saved without `publish` is a
committed, immutable resource with its own IRI that stays out of the outbox and
federation reads; sending it later belongs to #145. It is not a draft: drafts
(#144) are private, recoverable and possibly invalid working state and never
resources. Manually composed `Update` or `Delete` activities are ordinary
`create` saves and never change current state.

Publishing, editing and deleting require `reserveDispatch`, a callback that
runs inside the write's transaction after every other write. It may only
persist in that transaction, for example a durable dispatch reservation, and it
rolls the whole write back by throwing. The operations refuse to run without
it, so no GraphQL mutation exposes them until #145 supplies the reservation.


Preview and commit
------------------

~~~~ ts
import {
  commitLocalWrite,
  previewLocalWrite,
} from "@drfed/federation/local-write";

const env = { db, federation, rootOrigin, previewKey };
const principal = { accountId: account.id }; // from authentication only
const request = {
  operation: "create",
  actorId,
  document: { type: "Create", object: { type: "Note", content: "Hi" } },
  resources: [
    { path: [], kind: "activity" },
    { path: ["object"], kind: "object", representation: "reference" },
  ],
} as const;

const preview = await previewLocalWrite(env, principal, request);
// Show preview.preview.changes and resources; on approval:
const outcome = await commitLocalWrite(env, principal, request, {
  previewToken: preview.ok ? preview.preview.token : "",
});
~~~~

A preview checks permission and the document and returns every value the
server adds, including new IRIs, timestamps and generated activities, as
`changes` and complete saved `resources`. It writes nothing and holds no lock.
Its token is an HMAC over the account, a digest of the canonical request and
the allocated values, valid for an hour. `previewKey` is a `CryptoKey` for
HMAC-SHA256; a random key kept in memory per server process is enough, since a
restart only makes outstanding previews stale.

A commit requires a matching, unexpired token and saves exactly its values. It
locks the acting actor row, then reads permission in a later statement, so a
membership revoked while it waited is seen. It prepares the document again
under that lock, registers every IRI it may need once in sorted order, locks
the resources it writes in IRI order, and writes in one transaction. Failures
after the first write throw out of the transaction; nothing partial is left. A
replayed token finds its resources already saved (`resource_conflict`) or the
object already changed (`revision_conflict`).

| Error                   | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `invalid_request`       | Malformed request or resource descriptors, or a missing token or reservation.                |
| `invalid_document`      | Validator, authority or server-owned-field diagnostics at submitted paths.                   |
| `actor_not_found`       | The actor is missing, deleted, not local, on an expired instance, or not the member's.       |
| `invalid_instance_host` | The stored instance host cannot be parsed by this server.                                    |
| `stale_preview`         | The token is invalid, expired, or for another account or request.                            |
| `revision_conflict`     | The object's current revision is not the expected one.                                       |
| `resource_conflict`     | The resources were already saved, or an IRI is another kind of resource.                     |
| `unsupported_edit`      | The object is deleted, not the actor's, changes type, or cannot be kept in step (see below). |


Identity and documents
----------------------

New resources get UUIDv7 IRIs from Fedify's router: objects at
`/users/{actor}/{id}`, `Create` at `/ap/creates/{id}`, and every other activity
at `/ap/activities/{id}`, where [federation reads](federation-reads.md) serve
them. A new resource's `id`, its author (`actor` for an activity,
`attributedTo` for an object) and `published` are server-owned values given to
`prepareDocument()`; a submitted conflicting value is a
`server_owned_field_conflict`, never silently replaced. An edit owns `id`,
`attributedTo` and `updated`, and keeps the current `published`; an object
without one cannot gain one.

Every other identity claim is checked by meaning, through
`describeDocument()`, so aliases, full-IRI keys, `@id` aliases and compact IRIs
cannot hide it, also in the node objects of extension values, which
[federation reads](federation-reads.md) serve as well. An `actor` or
`attributedTo` value on a DrFed instance host, including the `id` of a document
or the `href` of a `Link` embedded there, must be an actor of the acting
actor's instance, and an `id` there must be a registered resource of a known
kind or one this write allocates. An IRI registered only because a document
addressed or referred to it has the `unknown` kind and does not count. Other
values are `unauthorized_local_identity` at their source paths. Remote
identities are not checked; copying a remote representation proves nothing
about it. Plain references, such as `object` or `target` IRIs, never request a
write and are never fetched or modified.

Resource descriptors name the root, `[]`, and optionally embedded documents
reached through `object`, `target`, `origin`, `result` or `instrument` of
another new resource. `kind: "activity"` needs an activity type;
`kind: "object"` needs a non-activity, non-actor, non-collection, non-`Link`
type, or a `Question`. A nested resource is saved as its own document stating
the context it inherited, including the implicit ActivityStreams context. Its
parent keeps it embedded, as submitted, or refers to it by IRI with
`representation: "reference"`; both are reported as changes.

Each saved document gets revision addressing and a current `addressing` index
from its semantic `to`, `cc`, `bto`, `bcc` and `audience`, each value at its
source position: IRIs as resolved, embedded documents by `id`, `Link` values by
`href`, also written as a list of one value, and anonymous values without a row.
Relations index `actor`, `object`, `target`, `origin`, `result`, `instrument`
and `attributedTo`. A document that spells one of these properties in several
ways is refused, since its index would otherwise leave occurrences out. Indexes
stay `partial`; the documents remain authoritative.


Edits and deletions
-------------------

An edit takes the complete new version and the revision it was made from. The
loaded document can be resubmitted with changes: its own `updated` value is
replaced instead of conflicting. The generated `Update` embeds the new version
without its context, keeps that context at its root, and copies the version's
addressing as written, blind recipients included in protected storage.
Earlier activities keep the versions they embedded, and IRI-only references
stay references.

A deletion appends a whiteout and keeps the object's current addressing, which
describes the last content. The generated `Delete` refers to the object by IRI
and copies the last version's addressing under its context.

Resources created by the common write have revisions only, so GraphQL details
ignore them until #154; federation reads serve their documents. Objects created
by the `createObject` mutation also have legacy typed rows that serving reads;
`writeTypedResourceRevision()` keeps those rows in step. Before writing, the
served columns must agree with the current revision, or the object is refused
as drifted. An edited version must fit the typed columns without loss: a `Note`
or `Article` with non-blank `content`, an optional single-language
`contentMap`, an explicit `sensitive`, plain strings and standard spellings.
The legacy serializer's Fedify context, which the validator cannot read
offline, is replaced by
`["https://www.w3.org/ns/activitystreams", { "sensitive": "as:sensitive" }]` as
a previewed change. A deleted legacy object is still served as a `Tombstone`
with `410 Gone`; its `Delete` uses the ActivityStreams context and the object's
standard addressing rows.


Compatibility
-------------

`createObject` keeps its established behavior through
`createLegacyObject()`: it creates a `Note` or `Article` with a `Create` in the
outbox, without delivering it, stores Fedify-serialized documents with blind
recipients, and captures legacy revisions. It shares the actor lock and
permission check with the common write, but takes no preview and runs no
document validation, because its input is not a submitted document. New
editors use the common write instead.

Tests live in *packages/federation/src/local-write.test.ts*, and PostgreSQL
concurrency tests in *local-write-postgres.test.ts* run with
`mise run test:postgres` and an isolated `DRFED_TEST_POSTGRES_URL`.
