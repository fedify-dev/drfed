Database lifecycle
==================

This page describes migration integrity, preparation and persistent database
ownership for contributors integrating `@drfed/models`. For deployment and
upgrade commands, see
[self-hosting](../manual/self-hosting.md#prepare-and-check-the-database).


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
stealing the lock. Migration errors have fixed codes and omit raw database
errors and credentials; the `drfed.models.migration` debug category records the
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

The CLI uses the safe preparation APIs described above.

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


Facade integration
------------------

The `drfed-server` facade uses these safe preparation APIs for automatic
migration and `inspectMigrationState()` for `--no-migrate`. Its persistent
PGlite owner remains held through preparation, serving and database cleanup.
The older `migrate()` function remains a low-level compatibility API; it does
not ensure exclusive access or provide this facade ownership and history
validation contract.

`preparePostgresDatabase` also accepts explicit node-postgres connection
settings as `credentials.connection`, without a `connectionString`. The facade
uses this form so that decoded host names, database names, credentials and TLS
policy are the same during migration and runtime. Both connections explicitly
verify the configured host identity for TLS, including IP addresses.

Keep the store open until the [runtime owner](runtime-lifecycle.md) has drained
its work. Schema upgrades also establish the retained history described in
[resource revisions](resource-revisions.md).
