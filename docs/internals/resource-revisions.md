Resource revisions
==================

This page is for contributors working on DrFed's storage and application
adapters. It describes the internal storage model and the contracts those
adapters must preserve.

`@drfed/models/resource-revision` stores ActivityStreams JSON independently of
the current `Note`/`Create` tables. It is a trusted database API for application
adapters. Reads return local documents, which may contain `bto` and `bcc`;
callers must authorize access and prepare a separate document for serving or
sending.

See [inbox persistence](inbox-persistence.md) for accepted remote writers,
[activity deliveries](activity-deliveries.md) for transport observations, and
[database lifecycle](database-lifecycle.md) for migration preparation.


Documents and history
---------------------

A canonical resource keeps its UUID, IRI and kind. Each revision has its own
UUID and increasing sequence, and `resource_heads` points to the latest one.
A stored activity has one revision. An object can have several snapshots,
followed by a terminal whiteout. Earlier snapshots, including objects embedded
in activities, keep their original values when a related object changes.

Snapshots retain parsed JSON values, including nested objects, arrays,
extensions, custom contexts and the difference between a reference, an embedded
object and a `Link`. They do not preserve source whitespace or numeric
spellings. An inbound delivery's `body` retains the received bytes. Storage
does not fetch references, validate vocabulary semantics, or infer a canonical
kind from the document's `type`; the document's JSON-LD expansion is recorded
beside it, as [Expansions](#expansions) describe. A `Question`, for example,
can be stored as an object or a stored activity according to the caller's
explicit `resourceKind`.

| Revision kind | Document     | Meaning                                                                                                           |
| ------------- | ------------ | ----------------------------------------------------------------------------------------------------------------- |
| `snapshot`    | A JSON value | Retained content. The generic append API accepts JSON objects; legacy capture can retain scalars and JSON `null`. |
| `unavailable` | SQL `NULL`   | A legacy typed row had no retained document. This does not invent a replacement document.                         |
| `whiteout`    | SQL `NULL`   | Deletion time and former types, with the preceding revision's addressing and relation projections.                |

Use `kind` to distinguish a snapshot containing JSON `null` from unavailable
content. A whiteout preserves history and prevents later appends; it does not
erase earlier content. Deleting a current typed row or an `instances` row also
leaves retained revisions. Canonical resources referenced by history cannot be
physically deleted through ordinary foreign-key cascades. There is no purge or
resurrection API.


Appending and reading
---------------------

Register the resource before appending. Pass `expectedRevisionId: null` for its
first revision and the current revision ID for every subsequent append. A stale
expectation raises `RevisionConflictError`. The helper locks the canonical row
and reads the head after acquiring the lock, so concurrent writers cannot
silently replace each other's changes. A failed append rolls back its document,
projections and head together. Inside a caller-owned transaction, it uses a
savepoint, so the caller can catch the error and continue that transaction.

This example assumes `db` is a DrFed `Database` supplied by the application:

~~~~ ts
import { ensureResource } from "@drfed/models";
import {
  appendResourceRevision,
  listResourceRevisions,
  loadCurrentResourceRevision,
  loadResourceRevision,
} from "@drfed/models/resource-revision";

const resource = await db.transaction((tx) =>
  ensureResource(tx, "https://example.test/objects/poll"),
);
const first = await appendResourceRevision(db, {
  resourceId: resource.id,
  resourceKind: "object",
  expectedRevisionId: null,
  kind: "snapshot",
  capture: "local",
  document: {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: resource.iri,
    type: "Question",
    name: "Which day?",
    oneOf: [{ type: "Note", name: "Monday" }, { type: "Note", name: "Friday" }],
  },
});
const deleted = await appendResourceRevision(db, {
  resourceId: resource.id,
  resourceKind: "object",
  expectedRevisionId: first.id,
  kind: "whiteout",
  deleted: Temporal.Now.instant(),
  formerTypes: ["Question"],
});

await loadCurrentResourceRevision(db, resource.id); // deleted
await loadResourceRevision(db, first.id);           // original Question
await listResourceRevisions(db, resource.id);       // newest first
~~~~

`listResourceRevisions` accepts `{ limit, beforeSequence }` as its third
argument. Limits range from 1 to 100 (default 20); `beforeSequence` selects
strictly older sequences. Current and revision-ID reads return `null` when
absent. They do not dereference remote IRIs or perform permission checks.

The append helper rejects non-JSON values rather than silently dropping or
converting them. It requires plain records and arrays, finite numbers, and no
cycles, accessors or symbol keys. Documents use a `json` column rather than
`jsonb`, so Unicode escapes that `jsonb` rejects are retained. Text projections
still require storable SQL text.

Generic appends raise `LegacyResourceRevisionError` for resources that have
legacy typed rows. Application adapters must coordinate the typed
projection and history instead of changing only one; for typed objects,
`writeTypedResourceRevision` does that (see below).
`ResourceRevisionStateError` covers immutable activities, appending after
deletion, and invalid initial whiteouts; conflicting canonical kinds raise
`ResourceKindConflictError`. Callers writing several resources in one
transaction must acquire their canonical locks in IRI order with
`lockResources` before appending.

### Typed objects

`writeTypedResourceRevision(db, input)` edits or deletes an object that has a
legacy typed `objects` row, so the typed row, its current addressing and the
history stay in step. The current revision must be the expected snapshot, and
the typed row's `document` and current addressing must still equal it (compared
as JSON text and as occurrence multisets); otherwise it raises
`RevisionConflictError` or `LegacyResourceRevisionError` and changes nothing.
A snapshot sets every served column the caller passes, including `updated`,
writes the same JSON to the typed `document` and the revision, and replaces
the current addressing with the given occurrences. A whiteout sets the typed
row's `deleted`, keeps its `updated` and current addressing, which go on
describing the last content, and inherits the previous projections. The
caller validates and authorizes the change and checks served columns, such as
`content_html`, against the old head; the helper does not derive columns from
documents. The whole write runs in a savepoint. Initial typed creation still
goes through legacy capture.


Projections and provenance
--------------------------

Documents are authoritative. `addressing` and `relations` are explicit indexes
provided by the caller; storage never scans arbitrary JSON-LD keys to guess
their meanings. Addressing retains root `to`, `cc`, `bto`, `bcc` and `audience`
order and duplicates. A snapshot append may pass `addressingOccurrences`
instead of `addressing`: explicit `{ property, position, iri }` entries that
keep each value's source position, so a value with no IRI, such as an anonymous
embedded object, leaves its position unused rather than shifting later ones.
`storeAddressingOccurrences` and `replaceAddressing` in `@drfed/models` write
the current `addressing` index the same way. Relation occurrences retain a
property, optional document path, `reference`/`embedded`/`link` representation
and optional target IRI. An anonymous embedded node needs no canonical resource
row, and a referenced remote IRI is not promoted to a typed object.

Projection status defaults to `partial`. `complete` is a trusted adapter's
claim that it indexed the supported root addressing and relationship
occurrences. It does not mean every nested extension or access rule was indexed
and grants no read permission. Whiteout projections describe the last content,
not a new document at those paths.

`capture` records `local`, `received`, `embedded` or `fetched`. A separate
`backfilled` flag marks rows created by the migration. Neither field proves
ownership or grants access. For legacy data, `fetched` inherits the old
conservative flag and is not proof that an HTTP fetch occurred.


Embedded document sources
-------------------------

`revision_embeddings` records where an embedded document of a revision came
from: its source path, the `source_revision_id` of a snapshot of another
resource, and its `relation`.  A `snapshot` keeps the source revision's
contents, apart from the context it inherits; a `derived` document started
from that revision and was changed, for example to test how a peer handles
other addressing.  An embedded document without a row has an unknown source,
which proves neither that it was nor that it was never saved as a revision:
older data and pasted documents lack the record.  An IRI reference is a
separate choice, recorded as the `reference` representation of a relation,
and has no source.  A source is no condition on reading the revision that
records it: who may read an embedded document is decided by the revision
embedding it alone.

Rows are written with the revision through the `embeddings` input of
`appendResourceRevision()` and `writeTypedResourceRevision()`, and like other
projections they cannot be added after the revision is published, changed or
removed.  The database also refuses a source that is not a snapshot or that
belongs to the same resource.  The
[local writes](local-writes.md#embedded-document-sources) decide the rows;
legacy capture and received documents record none.

Comparing an embedded document with the current state therefore compares
revisions of one resource by `sequence`, not timestamps of different
transactions, which do not follow commit order.


Expansions
----------

`revision_expansions` records the JSON-LD expanded form of each revision's
document, one row per revision, so that later reads such as searches work on
one uniform form instead of the many ways a document can be written.  It
supplements the stored document, which stays the authority: expansion loses
how keys were spelled, whether a value was an array, JSON `null`, and the
`@context` itself.

| `outcome`     | Recorded                                                     |
| ------------- | ------------------------------------------------------------ |
| `expanded`    | The expanded document, `dropped_terms` and `undefined_terms` |
| `failed`      | The `failure` reason, including the causes it wraps          |
| `no_document` | Nothing; the revision is `unavailable` or a `whiteout`       |

The expanded document is `jsonb`, so that it can be indexed and queried with
containment such as `document @> '[{"@type": [...]}]'`, and the terms are
`text[]`.  Being derived, they are stored normalized: U+0000 and unpaired
surrogates in strings and keys, which `jsonb` and `text` refuse, become
U+FFFD, and negative zero becomes zero.  The stored document keeps the exact
values.

Documents are expanded with the JSON-LD processor Fedify uses, re-exported by
`@fedify/vocab-runtime/jsonld`, so that an expansion reads a document as
Fedify read it.  Undefined terms are kept as they are read: the ActivityStreams
context maps them with `"@vocab": "_:"`, so a document using `Hashtag` or
`sensitive` under that context alone expands them to `_:Hashtag` and
`_:sensitive`, which Fedify does not read either.  `undefined_terms` lists
those terms, and `dropped_terms` lists those a context without `@vocab`
discarded.  Mastodon and Fedify define such terms in an inline context, so
their documents have neither.

No network access happens inside the transaction that stores a revision.
`expandDocument()` in `@drfed/models/expansion` reads only the contexts
preloaded by `@fedify/vocab-runtime` and those it is given.  The inbound
`Create` listener first gathers the remote contexts of a received document
through the federation's `contextLoader`, with `gatherContexts()` in
`@drfed/federation/expansion`, which expands the document once with a
loader recording every context loaded, scoped ones included, and expands the
activity from them, all before the transaction that stores the expansions
with the revisions.  An object embedded in it
lacks the context it inherits, so its expansion is the activity's first
`as:object` node, the one Fedify reads as the object, with
`source_revision_id` naming the activity revision it was taken from.  A
fetched object is expanded from its own document.  Local writes use
preloaded contexts only, so they are expanded offline when no expansion is
given.  An embedded snapshot appended without an expansion is refused, and a
legacy capture of a received, embedded or fetched snapshot without one, such
as an object reused from before expansions were stored, leaves it without a
row rather than recording an offline failure.  Documents are expanded as
Fedify reads them, keeping a node with only an `@id`; a stored value that is
not an object or array, which the processor would load as a URL, fails.

Unlike the other projections, rows are derived data: an incorrect expansion
is a bug in DrFed, fixed by recomputing the rows of the revisions it affected.
Addressing, relations and embedding sources are sealed with their revision
because they record what was stored; an expansion is an interpretation of it
that the stored document can reproduce.  The table therefore has no
immutability guard, and rows can be added after a revision is published, like
the `revision_receipts` index.  Which contexts or which version of the
processor produced an expansion is not recorded; the context URLs remain in
the stored document.

A revision without a row has not been expanded yet: it was stored before
expansions were, or is an embedded object captured without one.
`drfed-migrate --expand-revisions`, or `mise run expand:revisions` for a
development store, records them through `backfillExpansions()` in
`@drfed/federation/expansion-backfill`.  It runs outside transactions,
loads remote contexts with Fedify's document loader, and keeps a row another
writer recorded first, so it may run again.  It expands an embedded object
from the first revision of the activity that first carried it, the
`activity_id` of its typed row, and records a failure when that revision is
missing or no longer holds the same object.  It takes the object's node from
the activity's recorded expansion, recording that first, so the two agree
even when a remote context changed between runs.  Startup never runs it.


Legacy capture and upgrades
---------------------------

Existing local creation and accepted inbound `Create` paths capture their
finished documents and root addressing in the same transaction as the typed
rows. Local capture includes blind recipients. An incoming activity retains the
received JSON, and a reused object keeps the document from its first accepted
`Create`. The legacy projection is `partial` and has no relation rows; nested
values remain in the full document.

`captureLegacyResourceRevision(tx, resourceId)` is a trusted compatibility
operation for a fully written typed row. It copies database JSON directly,
initializes missing history, and reuses existing history only when the retained
JSON, capture and deletion metadata, and root addressing still agree. It
accepts no replacement document. A mismatch raises
`LegacyResourceRevisionError` and must roll back the surrounding write.

For the operator's upgrade procedure, see [Prepare and check the
database](/manual/self-hosting#prepare-and-check-the-database). Old writers must
remain stopped throughout migration. The additive migration preserves existing
UUIDs, IRIs, documents, collection memberships, addressing and delivery marks.
Every legacy object or activity gets a snapshot, or `unavailable` for SQL
`NULL`. Already-deleted objects also get a whiteout using the recorded deletion
time and former type. Snapshots use the old creation time. Actor soft deletion
alone does not create a whiteout.

`revision_receipts` is a mutable index of linked, verified inbound evidence.
It is separate from immutable content. Runtime linkage compares both the
current typed document and its first retained snapshot before adding a receipt.
Fetched evidence is recomputed when `recordFetchedObject` changes. Deleting a
typed object row removes its object receipts; deleting an activity or removing
a delivery linkage removes that delivery's receipts; deleting a delivery
cascades them. Unavailable and whiteout revisions receive no legacy receipt.
GraphQL reads each revision by this evidence, as
[GraphQL reads](#graphql-reads) describe.


Application boundaries
----------------------

The current editor and lists still use legacy `Note`/`Create` projections. A
generic canonical resource can have no typed detail; its GraphQL
`Resource.detail` is then `null`. [Federation reads](federation-reads.md) serve
such a resource from its current revision. The common write
operations described in [local writes](local-writes.md) save new resources as
revisions only and keep legacy typed objects in step when editing or deleting
them. GraphQL reads every revision by its own evidence, as
[GraphQL reads](#graphql-reads) describe.  The other federation surfaces are
separate work.

Appending a whiteout does not create or send a `Delete` activity. The common
delete operation appends it together with the `Delete`, outbox entry and the
caller's durable dispatch reservation in one transaction; sending happens
asynchronously. Federation reads serve a whiteout as a `Tombstone` with
`410 Gone`. Dispatch must freeze its own outgoing document; retained revisions
are not wire payloads.

Storage tests cover fixtures for 30 activity types, including `Activity` and
`IntransitiveActivity`, and the `Object` base. They include nested
`Undo`/`Like` and `Accept`/`Follow`, `Add` targets, `Arrive` without an object,
both uses of `Question`, and custom contexts and extensions. These are storage
round-trip fixtures, not claims of semantic validation or peer
interoperability. Run `mise run test` for PGlite coverage and
`mise run test:postgres` with an isolated `DRFED_TEST_POSTGRES_URL` for
PostgreSQL migration and concurrency checks.


GraphQL reads
-------------

`Resource.currentRevision`, `Resource.revisions` (newest first by sequence)
and `ResourceRevision` nodes read histories, generic resources included. A
revision returns its saved `document` as is, with blind recipients. Its
`root` and everything below it come from `interpretDocument()` in
`@drfed/federation/document`, which reads every vocabulary document by
meaning through `describeDocument()`; local writes build their revision
indexes with the same function. Relations are read from the document for
every embedded document, not from `revision_relations`, which hold the root's
only. When the validator cannot read the document, such as one whose context is
outside the offline allowlist or one with an unsupported property,
`interpreted` is false, `root` is null and `diagnostics` tell why; nothing
falls back to typed rows.

Read `DocumentNode.poll` on a standalone `Question` or on the embedded
`node` under `relations(property: object)` in a `Create` or `Update`.
Other document types return null for `poll`.

 -  `mode` is `exclusive` for `oneOf` and `inclusive` for `anyOf`, even
    when the saved document uses aliases. An open-ended Question has a null
    mode and an empty choice list.
 -  `choices` is sorted by source key, then by list position. Duplicates are
    preserved. Each choice has its source `path` and an `iri` for a reference
    or identified node. An embedded choice has a `node` with its saved
    document and extensions.
 -  `closed` holds a saved boolean, including `false`. `closedTime` holds a
    saved date-time as a `DateTime` instant. Both are null when absent.

The resource revision view shows the poll from the selected revision.
Expand an embedded choice to see its saved JSON.

Each revision is read by evidence of its own, in `readableRevision()` in
*packages/graphql/src/readable.ts*, not by the rule of its resource.  An
administrator reads every revision.  Anyone else reads one that was captured
`local`, whose own revision addressing names the public, or that a receipt
links to an inbound delivery to a local instance the viewer is an accepted
member of.  A revision without such evidence is readable only while it is the
current revision of a resource with a legacy typed row that the viewer may
read under `readableResource()`, even after a deletion hides
`Resource.detail`.  Local histories are therefore open to
anyone, blind recipients and unpublished activities included.  Evidence for
one revision opens no other: a later delivery naming the same IRI does not
open an earlier private revision, and a later restriction of the current
resource does not hide an earlier public one.  A Relay node lookup of a
revision checks the revision itself, and `Resource.revisions` leaves out the
ones the viewer may not read, so their sequences can skip.

The `Resource` a history is read through follows the same evidence, in
`readableResourceNode()`: a `node` lookup of a `Resource`, a relation's or
recipient's `resource`, and `Activity.object` return it when the viewer may
read it under `readableResource()` or may read any of its revisions.  A
`Resource` node shares its ID with the typed `Object` or `Activity` of the
same resource, so the lookup tells them apart by the typename of the global
ID; the typed node and `Resource.detail` keep following the current state.

What a revision embeds never decides whether it is readable.  A local
`Announce` that embeds a `Note` only one instance received is readable by
anyone, as every local revision is, whether it records that `Note`'s revision
as its source or was pasted without one: recording a source never makes a
document harder to read.  Only following the source checks the source
revision, as `DocumentNode.source` does below.  Received content stays
protected where it is read or imported: the received revision itself is
readable only by the evidence above, and a local write may declare as a
source only a revision its member may read, as
[local writes](local-writes.md#embedded-document-sources) describe.
`unreadableRevisions(viewer, ids)` in `@drfed/graphql/readable` applies the
same rule to a set of revisions for that check.

Deletion hides no revision by itself: deleting a resource appends a whiteout,
and its earlier revisions, like those of a resource whose author is deleted,
stay readable by their own evidence.  Only the existing fields, such as
`Resource.detail`, keep hiding deleted typed rows.  `Actor.objects` leaves
deleted objects out unless its `filter` sets `includeDeleted`, which lists
them with `Object.deleted` so that their histories can be reached.  A
relation's or recipient's `resource` is opened as `Activity.object` is, deleted
or not.

`DocumentNode.source` tells where an embedded document came from: its
`relation`, `snapshot` or `derived`, the source `revision`, and `status`,
which compares that revision with the current revision of its resource:
`current` when it is the current one, `deleted` when the current revision is
a whiteout, and `superseded` otherwise.  The status compares revisions only,
not contents.  It is null when the viewer may not read the current revision,
which would otherwise tell of a revision they may not read.  `source` is null
for the root, for an embedded document whose source is unknown, and when the
viewer may not read the source revision; these are not told apart, and
`relation` is not kept alone either, since `snapshot` next to the embedded
contents would tell those of a revision the viewer may not read.  Whatever
`source` is, the embedded `node`, the `root` and the raw `document` read as
the revision embedding them does.

`Resource.revision(sequence:)` returns one revision by its sequence, and null
both for a sequence with no revision and for a revision the viewer may not
read.
