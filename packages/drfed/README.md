@drfed/drfed
============

The main application package for [DrFed], a web-based platform for developing
and debugging ActivityPub apps.  It wires together the database layer, GraphQL
server, and HTTP server, and exposes the `drfed-server` CLI binary.

[DrFed]: https://drfed.org/


Usage
-----

~~~~ sh
drfed-server --data-path .pgdata
drfed-server --database-url postgres://localhost/drfed
~~~~

The server listens on `localhost:8888` by default.  Pass `--listen HOST:PORT`
to override.  Automatic database migrations run on startup unless `--no-migrate`
is given.


Environment
-----------

`DRFED_LOGIN_ORIGINS` is required and accepts a comma-separated list of HTTP
or HTTPS origins allowed in email login links:

~~~~ sh
DRFED_LOGIN_ORIGINS=https://drfed.example.com,http://localhost:3000 \
  drfed-server --data-path .pgdata
~~~~

For repository development, create the environment file loaded by
`mise run dev`:

~~~~ sh
cp packages/drfed/.env.example packages/drfed/.env
~~~~


Options
-------

| Option                    | Short | Description                                      |
| ------------------------- | ----- | ------------------------------------------------ |
| `--listen HOST:PORT`      | `-l`  | Address to listen on (default: `localhost:8888)` |
| `--pglite-data-path PATH` | `-d`  | Directory for PGlite storage                     |
| `--postgres-url URL`      | `-D`  | PostgreSQL connection URL                        |
| `--no-migrate`            | `-M`  | Skip automatic migrations                        |
| `--help`                  |       | Show help                                        |
| `--version`               |       | Show version                                     |

`--pglite-data-path` and `--postgres-url` are mutually exclusive.  One of them
must be provided.
