@drfed/models
=============

Database schema, Drizzle ORM types, and migration runner for [DrFed].  Supports
both PGlite (embedded) and PostgreSQL.

[DrFed]: https://drfed.org/


Schema
------

| Table              | Key columns                                          |
| ------------------ | ---------------------------------------------------- |
| `accounts`         | `id` (UUID), `email`, `created`                      |
| `instances`        | `id` (UUID), `slug`, `expires`, `created`            |
| `instance_members` | `instanceId` → `instances`, `accountId` → `accounts` |


Migrations
----------

Generate a migration after changing *src/schema.ts*:

~~~~ sh
mise run generate:migrate --name your_migration_name
~~~~

The *drizzle/* directory is included in the published npm package so that
installed users can run migrations without access to the repository source.


Activity log storage
--------------------

`activity_logs` stores delivery observations separately from ActivityPub
`activities`.  `@drfed/models/activity-log` exposes `recordInbound`,
`receiveInbound`, `recordOutbound`, and `settleOutbound`.  `receiveInbound`
marks an `acknowledged` inbound log `received` once a queued inbox listener
ran.  An inbound log keeps the received
octets in `body` and the request headers in `headers`; `payload` is the body
parsed as JSON, and is SQL `NULL` when it does not parse or holds U+0000 or an
unpaired surrogate, which jsonb cannot store.  `error` and `response_body`
are stored with U+FFFD for each U+0000, which text cannot store, so that a
remote response never keeps a log from being written.  `created` is when a
request arrived or a delivery started, and `completed` when DrFed answered the
request or the delivery last changed status.

`settleOutbound` settles the most recent pending (`queued` or `failed`)
delivery to an inbox and never changes a `sent`, `permanently_failed`, or
`abandoned` one.  Each attempt that ends is kept in `activity_log_attempts`, so
a retry never rewrites the outcome of an earlier attempt.

`activity_log_actors` relates a log to each local actor it concerns, as the
owner of the inbox, as an addressed recipient, or as the sender, with one row
per log and actor.  An addressed actor keeps every way it was addressed:
`addressed_directly` when the activity named the actor itself, and a row in
`activity_log_actor_collections` for each addressed collection it was a member
of.  Each row copies the log's `created`, by which an actor's logs are ordered.
Both record functions insert these rows in the same transaction as the log.
They record nothing and throw when the inbox owner, the sender, or an
addressed actor is not a local actor of the log's instance, since neither
foreign key can tell.

`@drfed/models/key` exposes public-JWK validation, RFC 7638/RFC 8037 SHA-256
thumbprints, and `observeKeyVersion`.  `keys` identifies each exact key IRI;
`key_versions` retains immutable public material per fingerprint.  Returning to
an earlier key reuses its version.  Observation timestamps do not describe
remote rotation times or continuous use.  Logs retain referenced versions with
`ON DELETE RESTRICT`, independently of Fedify cache expiry.
