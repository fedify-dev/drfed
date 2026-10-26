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


Resource revisions
------------------

`@drfed/models/resource-revision` provides trusted append and history reads for
full ActivityStreams JSON, with compare-and-swap heads and terminal deletion
markers. Existing local and inbound Create writers capture their documents in
the same transaction. Retained JSON can contain blind recipients; model reads
do not authorize access or prepare wire documents.

See the [resource revision internals] for API examples, projections, legacy
upgrades and the boundaries of editor, federation and dispatch integration.

[resource revision internals]: https://canary.drfed.org/internals/resource-revisions


Migrations
----------

Generate a migration after changing *src/schema.ts*:

~~~~ sh
mise run generate:migrate --name your_migration_name
~~~~

After reviewing newly generated SQL, register its identity:

~~~~ sh
mise run manifest:migrations --append
~~~~

This appends SHA-256 hashes of raw SQL bytes to *migrations-manifest.json* and
refuses to rewrite or remove existing entries. Builds verify the SQL against
this file and copy it to *dist/migrations-manifest.json*. `mise run check`
checks the same identities, and pull request CI compares the manifest with the
base commit to catch simultaneous changes to historical SQL and its hash.
Migration SQL is checked out with LF endings on every platform, so Git's
`core.autocrlf` setting does not change these raw-byte identities.
A base commit from before the manifest's introduction starts the baseline.

`@drfed/models/migration-manifest` exposes `verifyMigrationManifest()` for
installed package checks without connecting to a database. These checks do
not change the migration runner's database behavior.

`@drfed/models/migration-state` exposes `inspectMigrationState(client)`.
It uses only `SELECT` statements, verifies the installed manifest, and never
owns or closes the supplied query client. Exact named history is `ready`;
a strict prefix is `pending`. Changed hashes, diverged history, newer
migrations, unsupported table formats, and DrFed tables without tracked
history are reported separately. Legacy history must match both generation
seconds and hashes, and reports `upgrade-required` without altering metadata.
Named rows from Drizzle's legacy upgrade retain generation milliseconds and
have SQL `NULL` in `applied_at`; these also match by generation second, name,
and hash. Other named rows require the exact manifest timestamp.
Database query failures propagate instead of being treated as a fresh database.
Connections subject to row-level security on migration history are rejected,
since filtered rows cannot prove that the history is complete.

`@drfed/models/migration-session` exposes `preparePostgresDatabase()` for
PostgreSQL. It verifies bundled SQL, connects a fresh owned [`pg.Client`], takes
a session advisory lock, inspects history before any metadata DDL, applies
verified pending SQL or legacy upgrades, and checks exact history afterward.
The optional client factory must return an unconnected, exclusive client;
the runner owns `connect()` and `end()` and never reconnects after failure.
The runner hashes the exact SQL bytes again after acquiring the lock and gives
Drizzle a private temporary snapshot, so a concurrent installation change cannot
supply unverified SQL between validation and application.

`lockTimeoutMs` bounds connection and lock acquisition; SQL application is
not limited by that deadline. `signal` aborts waiting or closes an active
connection. PostgreSQL can retain an interrupted statement and its lock until
it observes the disconnect, so another runner continues to wait rather than
stealing the lock. Migration errors have fixed codes and omit raw DB errors
and credentials; the `drfed.models.migration` debug category records the
backend PID after locking. Use a direct database connection or a proxy that
preserves sessions; transaction pooling is unsupported.

`@drfed/models/pglite-preparation` exposes `preparePgliteDatabase({ store })`
for a store returned by `openPersistentPglite()`. It verifies SQL and history,
refuses incompatible or untracked schemas before metadata DDL, applies exact
verified snapshots, then requires ready history. Verified legacy milliseconds
are preserved during metadata upgrade. Preparers sharing one client are
serialized, so a later request inspects the first request's committed history.

The caller owns the store throughout preparation and must refrain from other
queries until it settles. Preparation never closes the database or releases
its native lock, even after failure. `signal` is checked at safe boundaries;
active WASM SQL settles before an aborted operation completes. Drain preparation
before `store.close()`.

The existing `migrate()` remains a low-level API whose caller must ensure
exclusive access. The CLI uses the safe preparation APIs described above.

For contributor tests, point `DRFED_TEST_POSTGRES_URL` at an isolated
PostgreSQL cluster with `CREATEDB` and `CREATEROLE` permissions, then run:

~~~~ sh
mise run test:postgres
~~~~

This task creates and removes unique test databases and roles. Ordinary
`mise run test` skips the service-dependent cases when that variable is absent.

The *drizzle/* directory is included in the published npm package so that
installed users can run migrations without access to the repository source.

[`pg.Client`]: https://node-postgres.com/apis/client


Persistent PGlite ownership
---------------------------

`@drfed/models/pglite-store` exposes `openPersistentPglite(dataPath)`. It
creates the directory, resolves its real absolute path, acquires an exclusive
native file lock, then constructs PGlite. Register the returned `close()`
immediately and await `ready` before querying. This promise maps asynchronous
initialization failures to the fixed `PgliteStoreError` code `open-failed`;
`close()` remains available even after an initialization failure. The shared
close promise shuts PGlite down before releasing its lock. If database close
fails, the lock stays held until that owner process exits.

[fs-native-extensions] supplies prebuilt Node addons for macOS, Windows and
Linux on x64/ARM64. Its file-description locks prevent another owner in the
same or a different process; suspension does not make a lock stale, and process
exit releases it. Loading an unavailable addon fails closed; there is no
compiler, heartbeat or PID-based fallback. Use a local filesystem. Network
filesystems and shared directories across container/PID namespaces are
unsupported.

The stable *.drfed.lock* file stays in the data directory after shutdown. Never
remove or replace it while an owner may be alive: two different inodes would
allow separate owners. A leftover file is harmless once the OS has released
its lock. After a failed close, stop that owner before reopening. Other code
that directly constructs PGlite bypasses this ownership API; coordinate all
access through it. The CLI uses this store for persistent PGlite databases.

The ordinary test task covers duplicate owners, a simultaneous process race,
symlink aliases, close ordering and failed-close ownership. POSIX-only tests
also suspend and forcibly terminate an owned child process before reopening.

[fs-native-extensions]: https://github.com/holepunchto/fs-native-extensions


Activity delivery storage
-------------------------

`activity_deliveries` stores delivery observations separately from ActivityPub
`activities`.  `@drfed/models/activity-delivery` exposes `recordInbound`,
`receiveInbound`, `recordOutbound`, and `settleOutbound`.  `receiveInbound`
marks an `acknowledged` inbound delivery `received` once a queued inbox
listener ran.  An inbound delivery keeps the received
octets in `body` and the request headers in `headers`; `payload` is the body
parsed as JSON, and is SQL `NULL` when it does not parse or holds U+0000 or an
unpaired surrogate, which jsonb cannot store.  `error` and `response_body`
are stored with U+FFFD for each U+0000, which text cannot store, so that a
remote response never keeps a delivery from being written.  `created` is when
a request arrived or a delivery started, and `completed` when DrFed answered
the request or the delivery last changed status.

`settleOutbound` settles the most recent pending (`queued` or `failed`)
delivery to an inbox and never changes a `sent`, `permanently_failed`, or
`abandoned` one.  Each attempt that ends is kept in
`activity_delivery_attempts`, so a retry never rewrites the outcome of an
earlier attempt.

`activity_id` links a delivery to the stored activity it carried.
`linkInboundActivity` links an inbound delivery only when it was verified and
answered with 2xx, by the activity IRI it recorded; `recordOutbound` takes the
`activityId` of the activity it sends.  `recordInbound` does not take one, and
a CHECK constraint refuses a linked inbound delivery that is not verified,
`received` or `acknowledged`.  A delivery outlives its activity.
`carried_snapshot` marks an inbound delivery whose payload is the stored
activity's document, and `carried_object_snapshot` one that carried the object
stored with that activity as well: the object was taken from the activity, or
`objects.fetched` says it was fetched and the delivery's `fetched_object`, what
its inbox listener fetched, is the stored document.  Neither record function
takes a mark; `linkInboundActivity` decides both anew on every link, and
`recordFetchedObject` again for a delivery linked before its listener ran, so
that a mark left from a deleted activity never carries over to another stored
under the same IRI.

`activity_delivery_actors` relates a delivery to each local actor it concerns,
as the owner of the inbox, as an addressed recipient, or as the sender, with
one row per delivery and actor.  An addressed actor keeps every way it was
addressed: `addressed_directly` when the activity named the actor itself, and
a row in `activity_delivery_actor_collections` for each addressed collection
it was a member of.  Each row copies the delivery's `created`, by which an
actor's deliveries are ordered.  Both record functions insert these rows in
the same transaction as the delivery.  They record nothing and throw when the
inbox owner, the sender, or an addressed actor is not a local actor of the
delivery's instance, since neither foreign key can tell.

`@drfed/models/key` exposes public-JWK validation, RFC 7638/RFC 8037 SHA-256
thumbprints, and `observeKeyVersion`.  `keys` identifies each exact key IRI;
`key_versions` retains immutable public material per fingerprint.  Returning to
an earlier key reuses its version.  Observation timestamps do not describe
remote rotation times or continuous use.  Deliveries retain referenced versions
with `ON DELETE RESTRICT`, independently of Fedify cache expiry.

The `drfed-server` facade now uses these safe preparation APIs for automatic
migration and `inspectMigrationState()` for `--no-migrate`. Its persistent
PGlite owner remains held through preparation, serving and database cleanup.
The older `migrate()` function remains a low-level compatibility API; it does
not provide this facade ownership and history validation contract.

`preparePostgresDatabase` also accepts explicit node-postgres connection
settings as `credentials.connection`, without a `connectionString`. The facade
uses this form so that decoded host names, database names, credentials and TLS
policy are the same during migration and runtime. Both connections explicitly
verify the configured host identity for TLS, including IP addresses.

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
