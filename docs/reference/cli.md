CLI reference
=============

`drfed-server` runs the DrFed backend. Self-hosters use it to configure the
database, instance origins, login email, and logging. The web frontend runs
separately.

When running from the repository, invoke it with `mise run drfed-server`.
The examples below use this task while package installation is being prepared.


Start the server
----------------

Use PGlite to store data in a local directory:

~~~~ sh
mise run drfed-server \
  --root-origin http://drfed.localhost:8888 \
  --login-origin http://localhost:3000 \
  --data-path .pgdata
~~~~

Or connect to PostgreSQL:

~~~~ sh
mise run drfed-server \
  --root-origin https://drfed.example.com \
  --login-origin https://drfed.example.com \
  --database-url postgres://localhost/drfed
~~~~

Supply `--root-origin`, at least one `--login-origin`, and exactly one database
option. The backend listens on `localhost:8888` by default and runs database
migrations on startup.


Server options
--------------

| Option                    | Aliases                | Description                                                      |
| ------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `--root-origin ORIGIN`    | `-r`                   | Required origin whose subdomains serve instances.                |
| `--login-origin ORIGIN`   |                        | Required frontend origin allowed in login links. Repeatable.     |
| `--listen HOST:PORT`      | `-l`                   | Listening address. Default: `localhost:8888`.                    |
| `--pglite-data-path PATH` | `--data-path`, `-d`    | Local PGlite storage directory.                                  |
| `--postgres-url URL`      | `--database-url`, `-D` | PostgreSQL connection URL.                                       |
| `--no-migrate`            | `-M`                   | Disable automatic database migrations.                           |
| `--email-from ADDRESS`    | `-f`                   | Sender address. Default: `noreply@` the root origin's host name. |
| `--smtp-url URL`          | `-s`                   | SMTP server URL. Without it, login email is written to the log.  |
| `--help`                  |                        | Show usage and available options.                                |
| `--version`               |                        | Show the version.                                                |

For `--root-origin https://drfed.example.com`, an instance named `example`
lives at `https://example.drfed.example.com`. Remote federation requires DNS
and HTTPS configuration for these subdomains. The root origin must use a host
name rather than an IP address.

`--login-origin` accepts HTTP or HTTPS origins. Repeat it when more than one
frontend origin should be allowed. The backend CLI does not read
`DRFED_LOGIN_ORIGINS`; that variable is used by the repository development
server.


Logging
-------

| Option              | Alias | Description                                                                |
| ------------------- | ----- | -------------------------------------------------------------------------- |
| `--log-level LEVEL` | `-L`  | `trace`, `debug`, `info`, `warning`, `error`, or `fatal`. Default: `info`. |
| `--log-output FILE` |       | Output destination. Use `-` for the console.                               |
| `--log-format TYPE` |       | `jsonl`, `logfmt`, `color`, or `plain`.                                    |

For example, add `--log-level debug` to a server command to see more detail.


Export the GraphQL schema
-------------------------

Export the schema without starting the server:

~~~~ sh
mise run generate:graphql-schema --output-file schema.graphql
~~~~

The underlying CLI options are `--generate-graphql-schema` and
`--output-file PATH` (or `-o`). The output defaults to standard output (`-`).
Server origins and database options are not required for schema export.


Create a local account
----------------------

The repository provides an account creation task:

~~~~ sh
mise run generate:account alice@example.com "Alice"
~~~~

Run it from the repository root after initializing the development database.
Stop the backend before running the task so both processes do not open the
same PGlite directory.

This task writes to *.pgdata/* in the repository root. It does not accept a
custom data path or PostgreSQL connection URL, and is not a `drfed-server`
subcommand. An existing email address is left unchanged. General account
provisioning for self-hosted deployments is not yet exposed through the CLI.

See [Self-hosting](/manual/self-hosting#create-an-account) for the account
creation walkthrough.
