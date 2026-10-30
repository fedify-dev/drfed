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
authority category is used by prepareDocument for caller-reported denials and
server-owned-field conflicts. validateDocument itself emits no authority
findings.

The document-only normalization is omission of empty `to`, `cc`, `bto`, `bcc`,
and `audience` arrays. For example, a Note with `to: []` receives the
`empty_addressing_list` warning and a removal change with reason
`omit_empty_addressing_list`; its preview omits `to`. Present changes for an
explicit caller decision. Validation does not apply them or save the preview.
It does not assign IDs or timestamps, replace actor/attribution identities,
deduplicate recipients, or convert references to embedded values.

### Preparing server-owned creation fields

`prepareDocument(document, options)` returns the same DocumentValidationResult
shape. It combines structural validation with explicit authority outcomes and
server-owned values supplied by trusted server code. The exported
DocumentPreparationOptions, DocumentAuthority, and ServerOwnedField types define
these inputs. Never populate options directly from editor/client JSON.

~~~~ ts
import { prepareDocument } from "@drfed/models/document";

// Server code has already checked permission and allocated these values.
const result = prepareDocument(submittedDocument, {
  authority: [{ allowed: true, path: [] }],
  serverOwnedFields: [
    { path: ["id"], value: allocatedObjectIri },
    { path: ["attributedTo"], value: authorizedActorIri },
    { path: ["published"], value: allocatedPublicationTimestamp },
  ],
});
~~~~

At least one explicit authority outcome is required. A denied outcome produces
unauthorized\_local\_identity (authority/error) at the supplied original path;
use `[]` for an operation-level denial. The function only reports this outcome:
`allowed: true` is not an authorization check or a reusable permission token.
Nested creations need the caller's separate permission outcomes. Embedded
values alone never request creation or modification of resources.

Owned-field paths must name id, actor, attributedTo, published, or updated on
existing supported root/nested documents. Supported aliases resolve to the same
field; diagnostics and changes retain original source spellings and indexes.
References and opaque extension data cannot be targets. The caller lists only
the fields it owns for that explicit creation operation; no default fields are
invented, and no values are generated from the clock or random IDs here.

| Submitted value                                                   | Preparation behavior                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Missing                                                           | Propose an add change with reason assign\_server\_owned\_field.                     |
| Null or a supported array containing only null                    | Propose a replace change retaining the original value in before.                    |
| Exactly one non-null string matching the server value             | Preserve the submitted representation, including a singleton array.                 |
| Different value, embedded identity, or additional non-null values | Report server\_owned\_field\_conflict (authority/error); never silently replace it. |
| Structurally malformed or unsupported input                       | Return its vocabulary/support diagnostics; do not prepare a successful preview.     |

Matching uses exact string equality, not URL canonicalization, timestamp
rewriting, or remote lookup. Structural multiplicity errors remain vocabulary
errors. Both identity strings and timestamps supplied by the server are checked
for supported syntax. Invalid trusted configuration, duplicate semantic field
declarations, or paths outside existing supported documents throw TypeError
when preparation reaches those checks; these are caller programming errors.

The preview combines server-field additions with existing empty-addressing
omissions, preserves custom properties, and is structurally revalidated. It
is returned only when checking completes without errors and changes exist.
Denied authority, conflicts, unsupported input, and truncated diagnostics
withhold both preview and changes. The input and trusted options are unchanged.

#152 owns actual permission checks, value allocation, preview-to-commit
coordination, persistence, and permission rechecks at write time. It must keep
the committed values consistent with the accepted preview. This module neither
saves anything nor adapts createObject. Both editors can display the shared
results; saving, publication, and sending remain separate operations.

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

| Applies to              | Properties and rules                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object and Link         | id: one IRI; mediaType: one MIME type; preview: references/lists; name/nameMap: text without HTML.                                                                        |
| Object                  | summary/content and summaryMap/contentMap: text, including HTML and empty strings; location and attributedTo: references/lists.                                           |
| Object                  | published, updated, startTime, endTime: one date-time each; to, cc, bto, bcc, audience: references/lists, with empty-array omission previews.                             |
| Activity                | actor, object, target, origin, result, instrument: references/lists. IntransitiveActivity, Arrive, Travel, and Question reject non-null object values.                    |
| Actor types             | preferredUsername: text; inbox/outbox: one IRI or embedded OrderedCollection or OrderedCollectionPage; following/followers/liked: one IRI or embedded Collection subtype. |
| Collection and subtypes | items/orderedItems: references/lists; totalItems: non-negative integer; current/first/last: one IRI or CollectionPage subtype. Counts need not match visible members.     |
| CollectionPage subtypes | partOf: one IRI or Collection subtype; next/prev: one IRI or CollectionPage subtype.                                                                                      |
| OrderedCollectionPage   | startIndex: non-negative integer.                                                                                                                                         |
| Link and Mention        | href: one IRI; hreflang: one language tag; rel: relation tokens/IRIs or lists; height/width: non-negative integers. Object-only content/location are unsupported.         |

Single-value properties accept a scalar or array containing at most one
non-null value; multiple values receive `invalid_multiplicity`. Null means
absence, including null list entries. Empty non-addressing arrays and nested
lists remain unsupported. Type arrays are excluded from this single-value rule.
Embedded activity actors and Object `attributedTo` values must use Application,
Group, Organization, Person, or Service for Fedify compatibility. Other
ActivityStreams-permitted embedded types receive `unsupported_value_form`;
IRI references remain supported without remote type checks. Object-only fields
such as `attributedTo` on Link receive `property_not_applicable`. Link `preview`
and `nameMap` remain supported by the vocabulary and Fedify's decoder.
Collection navigation accepts embedded CollectionPage values for current,
first, last, next, and prev, and Collection values for partOf, including
subtypes. Embedded Links in these fields receive `unsupported_value_form`
because Fedify rejects them. Diagnostics retain the original field/list paths.

Text accepts strings, flat lists, and supported `@value`/`@language` objects.
Language maps contain strings or null. Complex text attributes are unsupported.
Dates require a timezone and uppercase T/Z. Calendar checks use Temporal;
invalid dates receive `invalid_datetime`. ActivityStreams permits omitted
seconds, but representations Fedify cannot consume without failure or precision
loss receive `unsupported_value_form`: omitted seconds, fractions without
seconds, and fractions exceeding nine digits. Leap-second timestamps remain
unsupported. Validation preserves these values without adding seconds or
truncating precision. Timestamp validation does not establish server ownership
or ordering between fields.

Question is supported standalone and inside Create/Update using shared rules.
Its `oneOf`, `anyOf`, and `closed` fields remain unsupported pending #155's
poll rules. Open-ended Question needs no choices. Other types without
implemented rules, such as Place, receive support findings.

For 0.2.0, Object property rules for `tag`, `inReplyTo`, `url`, `attachment`,
`replies`, `icon`, `image`, `context`, `source`, `duration`, and `generator`
remain unimplemented. On Object documents, these fields produce
`unsupported_property` errors and set `complete: false`, preventing successful
validation even when their values are valid ActivityStreams. This limits which
documents pasted from fediverse servers can pass validation. Unknown custom
properties instead receive `extension_property_unchecked` warnings and can
survive successful validation without their semantics being checked. Full
coverage for the listed properties is deferred beyond 0.2.0 and tracked in
[#168].

[#168]: https://github.com/fedify-dev/drfed/issues/168

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
Inline terms must be nonempty, and resolved mapping IRIs must not contain
unescaped whitespace, control characters, or forbidden IRI punctuation.

Scoped contexts, custom base/vocabulary/default-language directives, context
resets, JSON literals, and other complex forms remain unsupported. Relative
IRIs remain unsupported until a trusted base policy exists. Custom properties,
mapped or unmapped, are preserved as opaque JSON and receive the compatibility
warning `extension_property_unchecked`. Their semantics are not validated.
Otherwise supported documents can finish with `complete: true` and no errors;
normalization previews preserve the custom fields and their nested values.
Opaque values are checked for JSON safety, including cycles and accessors,
without interpreting nested type or context keys as ActivityStreams.
Language-tagged value objects also require a string or null `@value` and a
string or null `@language`; malformed values receive `invalid_value_shape`
at the original keyword path. A null language tag leaves the value untagged.

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
contexts, representation limits, and nested traversal. Preparation tests
exercise supplied authority outcomes and generated-field previews. Database
permission enforcement and transaction integration remain #152 responsibilities.

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
