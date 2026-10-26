@drfed/models
=============

Database schema, Drizzle ORM types, and migration runner for [DrFed].  Supports
both PGlite (embedded) and PostgreSQL.

[DrFed]: https://drfed.org/


Document validation
-------------------

`@drfed/models/document` exports `validateDocument()` and its diagnostic types.
The initial implementation checks plain document roots with a single `Like`,
`Create`, or `Note` type. Activities accept optional `actor` references and
`object` references or embedded Notes, individually or in nonempty flat lists.
Notes inherit the parent context unless they supply their own. Shared checks
cover `id`, reference-only `attributedTo`, and string `content` (including HTML
and empty strings); optional values may be absent or null. It performs no
network access, database writes, permission checks, or normalization.

Findings use a stable `reason`, `category`, `severity`, and original-input
`path`. `complete` means checking finished, not that the document passed: also
check for diagnostics with `severity: "error"`. Unimplemented types,
properties, context forms, and other embedded types produce support errors
with `complete: false`. Full ActivityStreams coverage and the Fedify adapter
are still under development.

Nested findings retain the original path, for example
`["object", 1, "content"]`.
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
