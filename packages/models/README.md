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
`attributedTo`, and string `content` (including HTML and empty strings), and
`location` reference/embedded values. IntransitiveActivity and its supported
subtypes accept an omitted or null `object`; a non-null value receives
`property_not_applicable`. This restriction does not make other properties
required or remove their shared checks. Unsupported embedded types such as
Place still produces support findings. It performs no network access,
database writes, permission checks, or normalization. Object and Article reuse
the common checks at the root and when embedded, without acquiring
activity-only properties. They require an explicit supported type; handling an
omitted type remains separate work.

Actor types use the common Object checks. Actor and attribution properties
have Object-or-Link vocabulary ranges, so a supported non-actor Object is not
rejected merely for its class. Actor-specific fields such as
preferredUsername remain explicitly unsupported; collection links are checked
as described below; Link values use their own rules. These semantic
checks do not establish identity/authority or guarantee compatibility with
Fedify's narrower typed decoders.

Type detection belongs to this package. It uses Fedify's public
`getEntityTypeById()` and class inheritance, with an explicit
`implementedTypes` set in *src/document.ts* for the types described above.
Fedify recognizing a type does not automatically admit it. `@fedify/vocab` uses
the same `catalog:` version as the federation package (currently 2.4.3); the
shared catalog governs upgrades. Detection is synchronous and invokes no
vocabulary parser or JSON-LD processor.

Collections check items/orderedItems, non-negative totalItems, and typed
navigation values. OrderedCollectionPage also checks startIndex. Counts are
not required to match visible member length. Actor inbox/outbox support
references or embedded OrderedCollection/OrderedCollectionPage, and
following/followers/liked support Collection values. No reference is fetched.
Empty member lists and arrays on single-value collection fields remain
explicitly unsupported pending the shared representation policy.

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
Order and duplicate references are preserved. Empty non-addressing lists,
null entries, and nested lists remain explicitly unsupported until their
policies are agreed.


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
input. Name/language-value forms remain pending common-property coverage.
