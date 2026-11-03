DrFed
=====

[![GitHub Actions][GitHub Actions badge]][GitHub Actions]
[![License: AGPL-3.0-only][AGPLv3 badge]][AGPLv3]

DrFed is a web-based platform for developing and debugging [ActivityPub]
implementations, built by the team behind [Fedify]. It brings together the
tools you need to diagnose federation failures in one place: fetch and inspect
any ActivityPub object, monitor incoming activities in real time, step through
HTTP signature construction and verification, validate WebFinger and NodeInfo
responses, explore JSON-LD compaction and expansion, and send test activities
to any inbox. The goal is to make it straightforward to answer the question
“why doesn't my server federate with X?”—by showing you exactly which stage
broke, whether that's DNS, TLS, HTTP, signatures, or JSON-LD processing.

[GitHub Actions badge]: https://github.com/fedify-dev/drfed/actions/workflows/main.yaml/badge.svg
[GitHub Actions]: https://github.com/fedify-dev/drfed/actions/workflows/main.yaml
[AGPLv3 badge]: https://img.shields.io/github/license/fedify-dev/drfed
[AGPLv3]: https://www.gnu.org/licenses/agpl-3.0.html
[ActivityPub]: https://www.w3.org/TR/activitypub/
[Fedify]: https://fedify.dev/


Installation and server usage
-----------------------------

The official container image `ghcr.io/fedify-dev/drfed` contains all four
commands; see the [container installation guide] for Docker, Podman, and
other container tools.

DrFed requires Node.js 26 or newer. The first release will provide
`drfed-server`, `drfed-account`, `drfed-migrate` and `drfed-web` through npm:

~~~~ sh
npm install --global @drfed/drfed
drfed-account create --data-path .pgdata \
  --email operator@example.com --name Operator
drfed-server --root-origin http://drfed.localhost:8888 \
  --data-path .pgdata --mail-log-content
~~~~

PGlite allows only one process to own its data directory, so create the account
before starting the server. Account creation prepares a fresh database. The
server checks and applies pending migrations on startup. Open
`http://drfed.localhost:8888` for the frontend. The same listener serves
`/graphql`; DrFed test instances use subdomains of the root origin and serve
ActivityPub only. Open the configured origin, rather than `localhost:8888`.
Service deployments need wildcard DNS and TLS for those subdomains.

The default mail transport does not deliver messages. `--mail-log-content`
in the local example prints verification links so you can sign in during
development. Configure SMTP, SES or another documented delivery transport for
service deployments; message contents are excluded from logs by default.
Repository development uses `mise run dev` with separate backend and frontend
processes and explicitly enables login mail contents.

For a service deployment, select a TOML file with `--config` or `DRFED_CONFIG`.
CLI settings override `DRFED_*` environment variables, which override TOML
and defaults. No configuration files or *.env* files are searched
automatically. Relative TOML paths resolve against the configuration file's
directory.

~~~~ toml
[server]
root_origin = "https://drfed.example.com"
listen = "localhost:8888"

[database]
data_path = "data"
~~~~

~~~~ sh
drfed-server --config drfed.toml
drfed-server --config drfed.toml --no-migrate
~~~~

The HTTPS example assumes a reverse proxy that preserves the original `Host`
header and forwards requests to `localhost:8888`. Use `--no-migrate` to require
an already migrated database. See the [CLI package documentation]
for the environment variable names, PostgreSQL selection and mail settings.

[container installation guide]: https://drfed.org/installation/container/
[CLI package documentation]: ./packages/drfed/README.md


Database maintenance
--------------------

For PGlite, stop `drfed-server` before account creation or database
maintenance. For an upgrade, back up the database, install the new version,
then prepare and inspect it before starting the server:

~~~~ sh
drfed-migrate --config drfed.toml
drfed-migrate --config drfed.toml --check
drfed-server --config drfed.toml --no-migrate
~~~~

`--check` exits successfully only when database history matches the installed
migrations with no pending changes.
PostgreSQL can be selected with `--postgres-url` or `database.url`.


Separate serving
----------------

Use `drfed-server --no-web` and `drfed-web` to run the backend and frontend
separately. Pass the frontend's public origin to `drfed-server` with
`--login-origin`. See
the [CLI package documentation] for both modes, supported mail transports,
credential files and shutdown behavior. All four commands accept the same
explicit configuration file and the relevant `DRFED_*` variables.


Development builds
------------------

Install the latest successful development build with
`npm install --global @drfed/drfed@dev`.  The `dev` channel is separate from the
stable `latest` channel.  Tagged prereleases use `next`.  See
[the contributor release guide](./CONTRIBUTING.md#automated-npm-and-github-releases)
for verification, setup, and recovery procedures.


Documentation
-------------

The documentation site lives in *docs/* and uses [VitePress]. After
`mise install`, run `mise run dev:docs` to start it locally. Run
`mise run build:docs` to build the static site and `mise run preview:docs` to
preview the result.
See [*DEPLOY.md*](./DEPLOY.md) for how the site is deployed.

[VitePress]: https://vitepress.dev/
