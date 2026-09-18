@drfed/drfed
============

The main application package for [DrFed], a web-based platform for developing
and debugging ActivityPub apps.  It wires together the database layer, GraphQL
server, and HTTP server, and exposes the `drfed-server` CLI binary.

[DrFed]: https://drfed.org/


Usage
-----

~~~~ sh
drfed-server --root-origin https://drfed.example.com --data-path .pgdata
drfed-server --root-origin https://drfed.example.com \
  --database-url postgres://localhost/drfed
~~~~

The server listens on `localhost:8888` by default.  Pass `--listen HOST:PORT`
to override.  Automatic database migrations run on startup unless `--no-migrate`
is given.


Root origin
-----------

`--root-origin` is required, and everything else follows from it.  Each
instance is served from its own subdomain of that origin, so with
`https://drfed.example.com` the instance `foo-bar` lives at
`https://foo-bar.drfed.example.com`.  A non-default port belongs in the value
and is carried into every instance, which is what makes a development
deployment work:

~~~~ sh
drfed-server --root-origin http://drfed.localhost:8888 --data-path .pgdata
~~~~

Requests are routed by the authority they arrive on:

| Authority                             | Serves                                |
| ------------------------------------- | ------------------------------------- |
| `<slug>.<root domain>`                | ActivityPub only; GraphQL answers 404 |
| the root origin                       | GraphQL                               |
| the listening address, internal names | GraphQL                               |
| anything deeper under the root domain | 421 Misdirected Request               |
| an unusable `Host` header             | 400 Bad Request                       |

The authority has to match in full, port included.  A request for
`foo.drfed.example.com:8888` against a root origin of
`https://drfed.example.com` does not name an instance and is served the control
surface, not a 404, so do not read the table above as isolating GraphQL by host
name alone.  Ports 80 and 443 both count as no port at all, since which of them
is the default depends on a scheme that is deliberately not compared.

Not comparing the scheme is what lets a deployment sit behind a TLS-terminating
reverse proxy.  Such a proxy must pass two things through:

 -  `Host`, unchanged, because that is what names the instance.  A `Host`
    carrying the root zone's trailing dot is answered 400 rather than served,
    because the HTTP layer refuses it before DrFed sees it.
 -  `X-Forwarded-Proto: https`.  Without it the request looks like plain HTTP,
    and every actor URI DrFed mints names `http://`, which is not where the
    actor lives and not what the rest of the fediverse will accept.

Deploying this way needs a wildcard DNS record for `*.<root domain>` and, over
HTTPS, a wildcard TLS certificate to match.

Changing the root origin after instances exist does not move them.  Their host
names are already part of the actor URIs the rest of the fediverse has stored,
so the server only warns at startup about instances it can no longer reach.


Environment
-----------

`DRFED_LOGIN_ORIGINS` is required and accepts a comma-separated list of HTTP
or HTTPS origins allowed in email login links:

~~~~ sh
DRFED_LOGIN_ORIGINS=https://drfed.example.com,http://localhost:3000 \
  drfed-server --root-origin https://drfed.example.com --data-path .pgdata
~~~~

For repository development, create the environment file loaded by
`mise run dev`:

~~~~ sh
cp packages/drfed/.env.example packages/drfed/.env
~~~~

That file also carries `DRFED_ROOT_ORIGIN`, which `mise run dev` passes as
`--root-origin`.  It defaults to `http://drfed.localhost:8888`; every subdomain
of `localhost` resolves to the loopback address without any DNS or */etc/hosts*
setup, which is what makes per-instance subdomains usable locally.


Options
-------

| Option                    | Short | Description                                                          |
| ------------------------- | ----- | -------------------------------------------------------------------- |
| `--root-origin ORIGIN`    | `-r`  | Origin instances are subdomains of (required)                        |
| `--listen HOST:PORT`      | `-l`  | Address to listen on (default: `localhost:8888`)                     |
| `--pglite-data-path PATH` | `-d`  | Directory for PGlite storage                                         |
| `--postgres-url URL`      | `-D`  | PostgreSQL connection URL                                            |
| `--no-migrate`            | `-M`  | Skip automatic migrations                                            |
| `--email-from ADDRESS`    | `-f`  | Sender of login mail (default: `noreply@` at the root origin's host) |
| `--smtp-url URL`          | `-s`  | SMTP server to deliver mail through                                  |
| `--help`                  |       | Show help                                                            |
| `--version`               |       | Show version                                                         |

`--pglite-data-path` and `--postgres-url` are mutually exclusive.  One of them
must be provided.

Without `--smtp-url`, mail is written to the log instead of being delivered,
which is why a development server can sign you in without a mail server.
