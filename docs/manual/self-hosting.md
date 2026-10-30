Self-hosting
============

Run DrFed on your own server to keep your debugging workspace on your own
infrastructure. See the [CLI reference] for backend configuration options.

[CLI reference]: /reference/cli


Create an account
-----------------

Use `drfed-account create` with the same database settings as your server.
Stop a running PGlite server first: only one process can own its data
directory at a time.

~~~~ sh
drfed-account create --data-path .pgdata \
  --email alice@example.com --name "Alice"
~~~~

Replace the email address and display name with your own. The command prepares
a fresh database automatically. An existing account with the same normalized
email is returned without changing its name or privileges. Newly created
accounts are not administrators.

In the official container image, run the command through the server's Compose
service, as described for [Docker] and [Podman], or as a container with the
server's volume and settings, as described for [other container tools].

For a configured deployment, use the same TOML file:

~~~~ sh
drfed-account create --config drfed.toml \
  --email alice@example.com --name "Alice"
~~~~

PostgreSQL deployments can instead pass
`--database-url postgres://drfed@localhost/drfed`. The command prints JSON with
a `created` or `exists` status; both outcomes exit successfully.

When running from the repository, build first and invoke the same command
through its binary:

~~~~ sh
mise exec -- node packages/drfed/bin/drfed-account.mjs create \
  --data-path .pgdata --email alice@example.com --name "Alice"
~~~~

Start the server, open its configured public origin, and sign in with that
email address. Follow the login link delivered by your mail transport.
For local testing with log-only mail, explicitly enable `--mail-log-content`
to print login links; their contents are excluded by default.

See [Configuration] for shared settings and mail setup.

[Docker]: /installation/container/docker
[Podman]: /installation/container/podman
[other container tools]: /installation/container/other
[Configuration]: /manual/configuration


Prepare and check the database
------------------------------

`drfed-migrate` prepares the database without starting the server. If DrFed
uses PGlite, stop the DrFed server before running either command, because it
holds exclusive access to the database directory:

~~~~ sh
drfed-migrate --config drfed.toml
drfed-migrate --config drfed.toml --check
~~~~

`--check` inspects migration history without applying DrFed migrations. It
exits successfully only when the database matches the installed migrations
with no pending changes. Before upgrading, back up your database and stop
DrFed. Keep old server processes stopped while applying the new migrations,
then run `drfed-migrate --config drfed.toml --check` before restarting DrFed.

From the repository, invoke *packages/drfed/bin/drfed-migrate.mjs* through
`mise exec -- node` after building.
