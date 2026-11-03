CLI reference
=============

DrFed provides four commands for running and maintaining a deployment:

| Command         | Purpose                                    |
| --------------- | ------------------------------------------ |
| `drfed-server`  | Run the backend and embedded web frontend. |
| `drfed-account` | Create local accounts.                     |
| `drfed-migrate` | Prepare or inspect the database.           |
| `drfed-web`     | Run a separate frontend against a backend. |

When running from the repository, invoke it with `mise run drfed-server`.
For the other commands, build first and run the matching binary in
*packages/drfed/bin/* through `mise exec -- node`, such as
`mise exec -- node packages/drfed/bin/drfed-account.mjs --help`.


Start the server
----------------

Use PGlite to store data in a local directory:

~~~~ sh
mise run drfed-server \
  --root-origin http://drfed.localhost:8888 \
  --data-path .pgdata --mail-log-content
~~~~

Or connect to PostgreSQL:

~~~~ sh
mise run drfed-server \
  --root-origin https://drfed.example.com \
  --database-url postgres://drfed@localhost/drfed
~~~~

Supply a root origin through CLI options, the environment, or TOML. The server
listens on `localhost:8888` by default, or on `0.0.0.0:8888` in the official
[container image], and runs database migrations on startup.
Open the configured public origin for the frontend. If no database is selected,
DrFed uses PGlite in its default persistent OS data directory.

[container image]: /installation/container/


Server options
--------------

| Option                        | Aliases                | Description                                                                                |
| ----------------------------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| `--root-origin ORIGIN`        | `-r`                   | Required origin whose subdomains serve instances.                                          |
| `--login-origin ORIGIN`       |                        | Allowed login origin. Defaults to the public origin; required with `--no-web`. Repeatable. |
| `--listen HOST:PORT`          | `-l`                   | Listening address. Default: `localhost:8888`; `0.0.0.0:8888` in the container image.       |
| `--pglite-data-path PATH`     | `--data-path`, `-d`    | Local PGlite storage directory.                                                            |
| `--postgres-url URL`          | `--database-url`, `-D` | PostgreSQL connection URL.                                                                 |
| `--no-migrate`                | `-M`                   | Disable automatic database migrations.                                                     |
| `--email-from ADDRESS`        | `-f`                   | Sender address. Default: `noreply@` the root origin's host name.                           |
| `--smtp-url URL`              | `-s`                   | SMTP server URL; supports SMTP and SMTPS.                                                  |
| `--config FILE`               |                        | Select an explicit TOML configuration file.                                                |
| `--print-config`              |                        | Print effective settings and sources with secrets redacted; exit.                          |
| `--public-origin ORIGIN`      |                        | Frontend origin. Defaults to the root origin.                                              |
| `--no-web`                    |                        | Run only the backend; require explicit login origins.                                      |
| `--web`                       |                        | Enable the embedded frontend (default).                                                    |
| `--migrate`                   |                        | Enable automatic database migrations (default).                                            |
| `--migration-lock-timeout MS` |                        | Connection and migration lock wait. Default: `30000` milliseconds.                         |
| `--mail-transport KIND`       |                        | Select log-only mail, SMTP, JMAP, or a supported API transport.                            |
| `--mail-log-content`          |                        | Include login links and message contents in log-only mail.                                 |
| `--no-mail-log-content`       |                        | Exclude message contents from log-only mail (default).                                     |
| `--help`                      |                        | Show usage and available options.                                                          |
| `--version`                   |                        | Show the version.                                                                          |

For `--root-origin https://drfed.example.com`, an instance named `example`
lives at `https://example.drfed.example.com`. Remote federation requires DNS
and HTTPS configuration for these subdomains. The root origin must use a host
name rather than an IP address.

`--login-origin` accepts HTTP or HTTPS origins. Repeat it when more than one
frontend origin should be allowed. `DRFED_LOGIN_ORIGINS` accepts a JSON array
of origins. An explicit allowlist replaces the default and must include the
embedded frontend's public origin when the frontend is enabled.

All four commands accept `--config`, relevant `DRFED_*` variables, and
`--print-config`. See [Configuration] for precedence, paths, and mail settings.

[Configuration]: /manual/configuration


Logging
-------

| Option              | Alias | Description                                                                |
| ------------------- | ----- | -------------------------------------------------------------------------- |
| `--log-level LEVEL` | `-L`  | `trace`, `debug`, `info`, `warning`, `error`, or `fatal`. Default: `info`. |
| `--log-output FILE` |       | Output destination. Use `-` for the console.                               |
| `--log-format TYPE` |       | `jsonl`, `logfmt`, `color`, or `plain`.                                    |

For example, add `--log-level debug` to a server command to see more detail.


Shell completions
-----------------

All four commands can generate completion scripts for Bash (`bash`), zsh
(`zsh`), fish (`fish`), PowerShell (`pwsh`), and Nushell (`nu`):

~~~~ sh
drfed-server completion bash
~~~~

Replace `drfed-server` with `drfed-account`, `drfed-migrate`, or `drfed-web`
to generate that command's script. Installing the npm package does not
activate completions automatically.

For Bash, generate and load scripts for all four installed commands:

~~~~ bash
for command in drfed-server drfed-web drfed-migrate drfed-account; do
  "$command" completion bash > "$command-completion.bash"
  source "./$command-completion.bash"
done
~~~~

Run this in a directory where these filenames are available. Keep the command
binaries on `PATH` so completion callbacks can find them. For persistent
loading, move the scripts to a stable directory and source their absolute
paths from your interactive Bash startup file.

From the repository, build first and use
`mise exec -- node packages/drfed/bin/drfed-server.mjs completion bash`.
`mise run build` also generates scripts for all four commands and all five
shells; use `mise run generate:completion` to regenerate them explicitly.
The published package bundles them in its *completions/* directory.

See [Completion installation] for loading instructions for each shell and
local npm installations.

[Completion installation]: https://github.com/fedify-dev/drfed/blob/main/packages/drfed/README.md#completion-installation


Export the GraphQL schema
-------------------------

Export the schema without starting the server:

~~~~ sh
mise run generate:graphql-schema --output-file schema.graphql
~~~~

The underlying CLI options are `--generate-graphql-schema` and
`--output-file PATH` (or `-o`). The output defaults to standard output (`-`).
Server origins and database options are not required for schema export.


Create an account
-----------------

~~~~ sh
drfed-account create --data-path .pgdata \
  --email alice@example.com --name "Alice"
~~~~

The command accepts `--config`, `--data-path`, or `--database-url`, and prepares
the database by default. Use `--no-migrate` to require an already prepared
database. Stop a PGlite server before creating accounts in its directory.

See [Self-hosting](/manual/self-hosting#create-an-account) for the account
creation walkthrough.


Prepare the database
--------------------

~~~~ sh
drfed-migrate --data-path .pgdata
drfed-migrate --data-path .pgdata --check
~~~~

The first command applies migrations. `--check` inspects history without
applying DrFed SQL and exits successfully only when the database is ready.
Both accept the same configuration file and database selectors as the server.
Stop a PGlite server before running them.


Run a separate frontend
-----------------------

Run the backend with `--no-web` and an explicit login origin, then start
`drfed-web` against it:

~~~~ sh
drfed-server --no-web --root-origin http://drfed.localhost:8888 \
  --login-origin http://localhost:3000 --data-path .pgdata --mail-log-content
drfed-web --backend-url http://localhost:8888 \
  --public-origin http://localhost:3000 --listen localhost:3000
~~~~

Run the commands in separate terminals. `drfed-web` uses the backend's
`/graphql` endpoint. It defaults to listening on `localhost:3000` and reads
the TOML `web` settings, independently of the backend's listen setting.
Use HTTPS for a remote backend; remote HTTP requires explicit opt-in through
`--allow-insecure-backend`.
