Resource revisions
==================

This page is for contributors working on DrFed's storage and application
adapters. It describes the internal storage model and the contracts those
adapters must preserve.

`@drfed/models/resource-revision` stores ActivityStreams JSON independently of
the current Note/Create tables. It is a trusted database API for application
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
A stored Activity has one revision. An object can have several snapshots,
followed by a terminal whiteout. Earlier snapshots, including objects embedded
in Activities, keep their original values when a related object changes.

Snapshots retain parsed JSON values, including nested objects, arrays,
extensions, custom contexts and the difference between a reference, an embedded
object and a Link. They do not preserve source whitespace or numeric spellings.
An inbound delivery's `body` retains the received bytes. Storage does not fetch
references, expand contexts, validate vocabulary semantics, or infer a canonical
kind from the document's `type`. A `Question`, for example, can be stored as an
object or a stored Activity according to the caller's explicit `resourceKind`.

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
projection and history instead of changing only one.
`ResourceRevisionStateError` covers immutable Activities, appending after
deletion, and invalid initial whiteouts; conflicting canonical kinds raise
`ResourceKindConflictError`. Callers writing several resources in one
transaction must acquire their canonical locks in IRI order with
`lockResources` before appending.


Projections and provenance
--------------------------

Documents are authoritative. `addressing` and `relations` are explicit indexes
provided by the caller; storage never scans arbitrary JSON-LD keys to guess
their meanings. Addressing retains root `to`, `cc`, `bto`, `bcc` and `audience`
order and duplicates. Relation occurrences retain a property, optional document
path, `reference`/`embedded`/`link` representation and optional target IRI.
An anonymous embedded node needs no canonical resource row, and a referenced
remote IRI is not promoted to a typed object.

Projection status defaults to `partial`. `complete` is a trusted adapter's
claim that it indexed the supported root addressing and relationship
occurrences. It does not mean every nested extension or access rule was indexed
and grants no read permission. Whiteout projections describe the last content,
not a new document at those paths.

`capture` records `local`, `received`, `embedded` or `fetched`. A separate
`backfilled` flag marks rows created by the migration. Neither field proves
ownership or grants access. For legacy data, `fetched` inherits the old
conservative flag and is not proof that an HTTP fetch occurred.


Legacy capture and upgrades
---------------------------

Existing local creation and accepted inbound `Create` paths capture their
finished documents and root addressing in the same transaction as the typed
rows. Local capture includes blind recipients. An incoming Activity retains the
received JSON, and a reused object keeps the document from its first accepted
Create. The legacy projection is `partial` and has no relation rows; nested
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
Every legacy object or Activity gets a snapshot, or `unavailable` for SQL
`NULL`. Already-deleted objects also get a whiteout using the recorded deletion
time and former type. Snapshots use the old creation time. Actor soft deletion
alone does not create a whiteout.

`revision_receipts` is a mutable index of linked, verified inbound evidence.
It is separate from immutable content. Runtime linkage compares both the
current typed document and its first retained snapshot before adding a receipt.
Fetched evidence is recomputed when `recordFetchedObject` changes. Deleting a
typed object row removes its object receipts; deleting an Activity or removing
a delivery linkage removes that delivery's receipts; deleting a delivery
cascades them. Unavailable and whiteout revisions receive no legacy receipt.
Existing GraphQL permission checks still use their current evidence rules; the
new index does not expose historical content.


Application boundaries
----------------------

The current editor, lists and federation serializers still use legacy
Note/Create projections. A generic canonical resource can have no typed detail;
its GraphQL `Resource.detail` is then `null`. New general-purpose mutation,
historical authorization and federation surfaces are separate work.

Appending a whiteout does not create or send a `Delete` Activity. The later
application delete operation must append it together with the `Delete`, outbox
entry and durable dispatch reservation in one transaction, then send
asynchronously. Generic Tombstone serving with `410 Gone` belongs to that
federation integration. Dispatch must freeze its own outgoing document;
retained revisions are not wire payloads.

Storage tests cover 30 Activity type fixtures, including Activity and
IntransitiveActivity, and the Object base. They include nested Undo/Like and
Accept/Follow, Add targets, Arrive without an object, both uses of Question,
and custom contexts and extensions. These are storage round-trip fixtures, not
claims of semantic validation or peer interoperability. Run `mise run test` for
PGlite coverage and `mise run test:postgres` with an isolated
`DRFED_TEST_POSTGRES_URL` for PostgreSQL migration and concurrency checks.
