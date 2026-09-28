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
`activities`. `@drfed/models/activity-log` exposes `recordInbound`,
`recordOutbound`, and `settleOutbound`.

`@drfed/models/key` exposes public-JWK validation, RFC 7638/RFC 8037 SHA-256
thumbprints, and `observeKeyVersion`. `keys` identifies each exact key IRI;
`key_versions` retains immutable public material per fingerprint. Returning to
an earlier key reuses its version. Observation timestamps do not describe
remote rotation times or continuous use. Logs retain referenced versions with
`ON DELETE RESTRICT`, independently of Fedify cache expiry.
