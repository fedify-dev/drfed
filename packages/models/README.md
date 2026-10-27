@drfed/models
=============

Database schema, Drizzle ORM types, and migration runner for [DrFed].  Supports
both PGlite (embedded) and PostgreSQL.

[DrFed]: https://drfed.org/


Document validation
-------------------

`@drfed/models/document` exports `validateDocument()` and its diagnostic types.
The implementation checks plain document roots with a single supported type:
both activity base types, all twenty-eight named activity subtypes, and the
Object, Article, and Note object types plus Application, Group, Organization,
Person, and Service, plus Collection, OrderedCollection, CollectionPage,
and OrderedCollectionPage, plus Link and Mention.
Travel and Question use the shared intransitive checks. Question-specific
`oneOf`, `anyOf`, and `closed` fields remain unsupported until #155 adds their
rules; their input is preserved with `complete: false`. Open-ended questions
need no choices, and Create/Update-embedded Questions share the same checks.
Activities accept optional `actor` references or supported embedded values.
Their `object`, `target`, `origin`, `result`, and `instrument` values accept
references or supported embedded objects or activities, individually
or in nonempty flat lists. Embedded objects inherit the parent context unless
they supply their own. Shared checks cover `id`, reference/embedded
`attributedTo`, text `content` (including HTML and empty strings), and
`location` reference/embedded values. IntransitiveActivity and its supported
subtypes accept an omitted or null `object`; a non-null value receives
`property_not_applicable`. This restriction does not make other properties
required or remove their shared checks. Unsupported embedded types such as
Place produce support findings. It performs no network access,
database writes, or permission checks. Object and Article reuse
the common checks at the root and when embedded, without acquiring
activity-only properties. They require an explicit supported type; handling an
omitted type remains separate work.

Actor types use the common Object checks. Actor and attribution properties
have Object-or-Link vocabulary ranges, so a supported non-actor Object is not
rejected merely for its class. Actor preferredUsername uses the text checks;
collection links are checked
as described below; Link values use their own rules. These semantic
checks do not establish identity/authority or guarantee compatibility with
Fedify's narrower typed decoders.

Type detection belongs to this package. It uses Fedify's public
`getEntityTypeById()` and class inheritance, with an explicit
`implementedTypes` set in *src/document.ts* for the types described above.
Fedify recognizing a type does not automatically admit it. `@fedify/vocab` uses
the same `catalog:` version as the federation package (currently 2.4.3); the
shared catalog governs upgrades. Detection is synchronous and invokes no
vocabulary parser or JSON-LD expansion.

Context interpretation uses allowlisted bundled data from the same catalog
version of `@fedify/vocab-runtime`. The current allowlist is the ActivityStreams
context and `https://w3id.org/security/v1`. Flat context arrays and simple
inline term/prefix definitions are supported; the effective context must
include the standard ActivityStreams vocabulary. Embedded documents inherit
context, and local overrides of aliases do not change siblings. Standard terms
cannot be overridden.

Aliases reuse existing property checks while retaining original field names
and list indexes. Type coercion and language/list containers must match the
supported term; an IRI match alone does not establish equivalent JSON-LD
meaning. For example, an object alias needs `@type: "@id"`. Functional aliases
are checked together for multiplicity without merging their source values.
Unknown custom properties and known properties without checker rules remain
unsupported, with input retained. Parsing an extension definition does not
admit its property into checker coverage.

Scoped term contexts, custom base/vocabulary/default-language directives,
context resets, JSON literals, and other complex JSON-LD features remain
explicitly unsupported. Malformed definitions produce invalid\_context;
contexts outside the allowlist produce context\_unavailable\_offline. Validation
never fetches a context or resource and remains synchronous.

Collections check items/orderedItems, non-negative totalItems, and typed
navigation values. OrderedCollectionPage also checks startIndex. Counts are
not required to match visible member length. Actor inbox/outbox support
references or embedded OrderedCollection/OrderedCollectionPage, and
following/followers/liked support Collection values. No reference is fetched.
Empty member lists remain explicitly unsupported. Functional properties,
including counts and navigation, accept a scalar or an array with at most one
non-null value. Additional values produce invalid\_multiplicity; array indexes
remain part of each value's diagnostic path.

Common text checks cover name, summary, content, their nameMap/summaryMap/
contentMap forms, and explicit @value/@language objects. Text lists and null
entries preserve their original order and indexes. Name rejects HTML markup;
content and summary may contain HTML. Language-map values must be strings or
null; complex JSON-LD text attributes remain unsupported.

Published, updated, startTime, and endTime use the ActivityStreams date-time
format: timezone required, uppercase T/Z, seconds optional. Calendar and offset
checks use Temporal. Leap-second values remain explicitly unsupported. These
checks do not decide server ownership, generate timestamps, or enforce time
ordering between fields.

Object subtypes accept to/cc/bto/bcc/audience through shared reference and
embedded-value checks. Empty addressing produces a compatibility warning.
When checking completes without errors, changes proposes removing each empty
addressing field and normalizedDocument supplies an independent preview. The
input remains unchanged; callers must explicitly choose the preview. No
preview is returned for errors, incomplete checking, or diagnostic truncation.

Findings use a stable `reason`, `category`, `severity`, and original-input
`path`. `complete` means checking finished, not that the document passed: also
check for diagnostics with `severity: "error"`. Unimplemented types,
properties, context forms, and other embedded types produce support errors
with `complete: false`. Full ActivityStreams coverage is still under
development; the offline Fedify adapter is optional later work.

Nested findings retain the original path, for example
`["object", 1, "content"]`.
Checks use an explicit work stack, preserving depth-first order without
recursive calls. Cycles in traversed objects receive `non_json_value`; shared
objects in separate branches are allowed. No depth limit is imposed yet.
Order and duplicate references are preserved. Null list entries mean absence.
Empty non-addressing lists and nested lists remain explicitly unsupported.
Relative IRIs remain unsupported until a trusted base-IRI policy is agreed.


Schema
------

| Table              | Key columns                                          |
| ------------------ | ---------------------------------------------------- |
| `accounts`         | `id` (UUID), `email`, `created`                      |
| `instances`        | `id` (UUID), `slug`, `expires`, `created`            |
| `instance_members` | `instanceId` → `instances`, `accountId` → `accounts` |


Resource revisions
------------------

`@drfed/models/resource-revision` provides trusted append and history reads for
full ActivityStreams JSON, with compare-and-swap heads and terminal deletion
markers. Existing local and inbound Create writers capture their documents in
the same transaction. Retained JSON can contain blind recipients; model reads
do not authorize access or prepare wire documents.

See the [resource revision internals] for API examples, projections, legacy
upgrades and the boundaries of editor, federation and dispatch integration.

[resource revision internals]: https://drfed.org/internals/resource-revisions


Database lifecycle
------------------

See [database lifecycle internals] for migration
manifests, history inspection, safe PostgreSQL and PGlite preparation, native
file locks, and contributor verification commands. The caller owns borrowed
clients and stores; preparation does not replace runtime cleanup.

[database lifecycle internals]: https://drfed.org/internals/database-lifecycle


Activity deliveries
-------------------

`@drfed/models/activity-delivery` stores delivery observations separately from
ActivityPub resources. See [activity delivery internals] for
recording, attempt history, snapshot receipts and observed signing keys.

[activity delivery internals]: https://drfed.org/internals/activity-deliveries


Database upgrades
-----------------

Installed users can run `drfed-migrate` from `@drfed/drfed` to prepare the
database; `drfed-migrate --check` only inspects history and exits 0 for ready
or 1 for every other status/error. Both commands accept the facade's shared
TOML and database environment/CLI settings. Stop a PGlite server before either
command because its directory remains exclusively locked. For PostgreSQL
inspection with a separate runtime role, grant `USAGE` on the migration schema
and `SELECT` on its history table, for example:

~~~~ sql
GRANT USAGE ON SCHEMA drizzle TO drfed_runtime;
GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO drfed_runtime;
~~~~

Back up and stop DrFed before an update, install the updated package, run
`drfed-migrate`, verify `drfed-migrate --check`, then start the server. Keep the
backup until the updated application has been verified. Installed users do not
need `drizzle-kit`; it is a developer tool for generating migration SQL.

Link and Mention check optional href, rel, mediaType, hreflang, height/width,
and preview. Collection navigation also accepts Link values. Type detection
uses their exported Fedify classes because the installed entity registry
excludes them. MIMEType and Intl.Locale provide lexical checks without changing
input. Link name and nameMap use the common text checks.
