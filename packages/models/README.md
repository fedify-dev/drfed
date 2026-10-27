@drfed/models
=============

Database schema, Drizzle ORM types, and migration runner for [DrFed].  Supports
both PGlite (embedded) and PostgreSQL.

[DrFed]: https://drfed.org/


Document validation
-------------------

`@drfed/models/document` exports synchronous
`validateDocument(document: unknown)` and the `DocumentValidationResult`,
`Diagnostic`, `DiagnosticReason`, `FieldPath`, and `NormalizationChange` types,
plus the `diagnosticReasons` registry. Pass parsed JSON, not JSON text.
Validation performs no network access, database writes, permission checks, or
delivery, and never mutates input.

### Consumer contract

The structured builder (#140) supplies its document; the raw editor (#141)
parses JSON first and owns syntax errors and text locations. Both call the same
validator. Paths identify original property names and zero-based list indexes,
including aliases; `[]` identifies the root. Map these paths to controls or
source locations without comparing human-readable messages.

~~~~ ts
import { validateDocument } from "@drfed/models/document";

const result = validateDocument({
  "@context": "https://www.w3.org/ns/activitystreams",
  type: "Accept",
  object: [{ type: "Follow", actor: false }],
});
// invalid_value_shape at ["object", 0, "actor"]
const structurallyAccepted =
  result.complete &&
  !result.diagnostics.some(({ severity }) => severity === "error");
~~~~

| Result field       | Caller interpretation                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| complete           | Checks finished. A definite malformed-input result can be complete; this is not a validity or permission flag.                                         |
| diagnostics        | Each finding has a stable reason, category, severity, original-input path, and display message. Use reason for machine decisions; messages may change. |
| changes            | Proposed changes with operation, reason, path, message, and before/after values as applicable. Empty when no preview is available.                     |
| normalizedDocument | Independent preview, present only when changes are proposed, checking is complete, and no errors occur. Input remains unchanged.                       |

Vocabulary errors describe malformed supported input. Support errors describe
unimplemented types, properties, or representations and make `complete` false.
Compatibility warnings do not automatically reject the document. An omitted
context uses the standard ActivityStreams context with a warning. The exported
category union reserves `authority`, but this entry point does not emit
permission findings and the registry currently has no authority-specific reason.

The current normalization is omission of empty `to`, `cc`, `bto`, `bcc`, and
`audience` arrays. For example, a Note with `to: []` receives the
`empty_addressing_list` warning and a removal change with reason
`omit_empty_addressing_list`; its preview omits `to`. Present changes for an
explicit caller decision. Validation does not apply them or save the preview.
It does not assign IDs or timestamps, replace actor/attribution identities,
deduplicate recipients, or convert references to embedded values.

#152 can reuse this entry point, but write-operation integration and the
server-owned-field contract remain pending. Structural acceptance never
establishes permission: the server must enforce authorization at write time,
including when callers bypass either editor. Saving, publication, and sending
are separate operations. No successful lookup or remote-resource existence is
implied by accepting an IRI.

### Supported types and properties

The checker admits both activity base types and all 28 named activity subtypes,
plus Object, Note, Article, Application, Group, Organization, Person, Service,
Collection, OrderedCollection, CollectionPage, OrderedCollectionPage, Link,
and Mention. Optional properties stay optional. Each document needs one
supported type string; all type arrays, including singleton arrays, are
unsupported. Unknown types are retained without being converted to Note.

Type detection uses Fedify's public registry and inheritance, with an explicit
implemented-type set. Link and Mention use their exported classes because the
installed registry excludes them. Models and federation share the catalog
version of `@fedify/vocab` (currently 2.4.3); context data comes from the
matching `@fedify/vocab-runtime`. Recognition by Fedify alone does not
establish checker coverage. No vocabulary parser or full JSON-LD expansion runs
here.

In the table, Object includes its admitted subtypes, including activities,
actors, and collections. References are absolute IRIs or supported embedded
Object/Link values. Reference lists retain order, duplicates, and source
indexes.

| Applies to              | Properties and rules                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Object and Link         | id: one IRI; mediaType: one MIME type; attributedTo and preview: references/lists; name/nameMap: text without HTML.                                                                  |
| Object                  | summary/content and summaryMap/contentMap: text, including HTML and empty strings; location: references/lists.                                                                       |
| Object                  | published, updated, startTime, endTime: one date-time each; to, cc, bto, bcc, audience: references/lists, with empty-array omission previews.                                        |
| Activity                | actor, object, target, origin, result, instrument: references/lists. IntransitiveActivity, Arrive, Travel, and Question reject non-null object values.                               |
| Actor types             | preferredUsername: text; inbox/outbox: one IRI or embedded OrderedCollection or OrderedCollectionPage; following/followers/liked: one IRI or embedded Collection subtype.            |
| Collection and subtypes | items/orderedItems: references/lists; totalItems: non-negative integer; current/first/last: one IRI, CollectionPage subtype, or Link subtype. Counts need not match visible members. |
| CollectionPage subtypes | partOf: one IRI, Collection subtype, or Link subtype; next/prev: one IRI, CollectionPage subtype, or Link subtype.                                                                   |
| OrderedCollectionPage   | startIndex: non-negative integer.                                                                                                                                                    |
| Link and Mention        | href: one IRI; hreflang: one language tag; rel: relation tokens/IRIs or lists; height/width: non-negative integers. Object-only content/location are unsupported.                    |

Single-value properties accept a scalar or array containing at most one
non-null value; multiple values receive `invalid_multiplicity`. Null means
absence, including null list entries. Empty non-addressing arrays and nested
lists remain unsupported. Type arrays are excluded from this single-value rule.
Actor and attribution vocabulary ranges are Object-or-Link, not restricted to
actor classes; this does not guarantee compatibility with Fedify's narrower
typed decoders.

Text accepts strings, flat lists, and supported `@value`/`@language` objects.
Language maps contain strings or null. Complex text attributes are unsupported.
Dates require a timezone and uppercase T/Z; seconds are optional. Calendar
checks use Temporal; leap-second timestamps remain unsupported. Timestamp
validation does not establish server ownership or ordering between fields.

Question is supported standalone and inside Create/Update using shared rules.
Its `oneOf`, `anyOf`, and `closed` fields remain unsupported pending #155's
poll rules. Open-ended Question needs no choices. Other types/properties without
implemented rules, such as Place or duration, receive support findings.

### Context and preservation limits

The context allowlist includes the standard ActivityStreams context (HTTPS and
its accepted HTTP spelling) and `https://w3id.org/security/v1`. Flat context
arrays and simple inline term/prefix definitions are supported. Effective
contexts must include the standard ActivityStreams vocabulary; standard terms
cannot be overridden. Embedded values inherit context; local alias overrides
are isolated from siblings.

Aliases must have compatible coercion and containers. For example, an object
alias needs `@type: "@id"`; matching a property IRI alone is insufficient.
Functional aliases are counted together without merging source values.
Malformed context definitions receive `invalid_context`; unavailable contexts
receive `context_unavailable_offline`, not an empty replacement. There are no
remote lookups or remote lookup failures to interpret in this API.

Scoped contexts, custom base/vocabulary/default-language directives, context
resets, JSON literals, and other complex forms remain unsupported. Relative
IRIs remain unsupported until a trusted base policy exists. Custom properties,
mapped or unmapped, are preserved as opaque JSON and receive the compatibility
warning `extension_property_unchecked`. Their semantics are not validated.
Otherwise supported documents can finish with `complete: true` and no errors;
normalization previews preserve the custom fields and their nested values.
Opaque values are checked for JSON safety, including cycles and accessors,
without interpreting nested type or context keys as ActivityStreams.

This warning policy does not admit unknown types, unsupported contexts,
JSON-LD keywords, or known vocabulary properties without implemented rules.
Those still block validation. Passing validation does not guarantee custom
fields survive Fedify serialization or sending. This supersedes the earlier
policy that rejected all custom properties.

Diagnostics are capped at 100, including a final `diagnostic_limit_reached`
error diagnostic when truncated; checking then remains incomplete and no
preview is returned. Traversal is iterative, with no depth/value-count limit
currently. Cycles in traversed values receive `non_json_value`; shared sibling
objects are allowed.

### Executable examples

All 138 cases in [the fixture file] are exercised by [the document tests]
through the built package export. Cases include `undo-nested-number`,
`accept-follow-list-actor`, `addressing-empty`, `context-alias-number`, and
`extension-mixed-type`. Fixture expectations contain reasons and paths;
category and severity are checked against the registry. Input preservation and
preview contents are asserted. Additional tests exercise network avoidance,
contexts, representation limits, and nested traversal. Authority tests remain
pending the write-operation contract.

[the fixture file]: ../../fixtures/document-validation/initial.json
[the document tests]: src/document.test.ts


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
