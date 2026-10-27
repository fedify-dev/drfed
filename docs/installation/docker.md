Docker
======

The official image `ghcr.io/fedify-dev/drfed` contains all four DrFed
commands: `drfed-server`, `drfed-account`, `drfed-migrate`, and `drfed-web`.
It runs on `linux/amd64` and `linux/arm64`, and needs no Node.js on the host.
The examples below use [Docker Compose].

[Docker Compose]: https://docs.docker.com/compose/


Quick start
-----------

Save this file as *compose.yaml* in an empty directory:

<<< ../../docker/compose.pglite.yaml#compose{yaml}

Create your account, then start DrFed:

~~~~ sh
docker compose run --rm drfed drfed-account create \
  --email alice@example.com --name "Alice"
docker compose up -d drfed
~~~~

Replace the email address and display name with your own. Open
`http://drfed.localhost:8888` and sign in with your email address. This local
example prints the login link to the container log instead of sending mail:

~~~~ sh
docker compose logs -f drfed
~~~~

Follow the `open http://drfed.localhost:8888/login/…` link in the log to finish
signing in.

The image runs `drfed-server` by default.  Arguments that start with `-` are
passed to `drfed-server`, and any other command runs as given, so
`docker compose run --rm drfed drfed-migrate --check` runs `drfed-migrate`.


Configuration in containers
---------------------------

Configure the container with the same `DRFED_*` environment variables,
command-line options, and TOML file as any other installation; see
[Configuration].  The usual precedence applies: command-line options, then
environment variables, then the TOML file, then defaults.

Set `DRFED_ROOT_ORIGIN` to the origin that browsers and other servers use to
reach DrFed, not the address the container listens on.  The image sets
`DRFED_CONTAINER=1`, which only changes the default listening host of
`drfed-server` and `drfed-web` to `0.0.0.0`, keeping ports 8888 and 3000.
`--print-config` reports it as a default, and any configured `server.listen`
or `web.listen` replaces it.  The image ships no TOML file; select your own
with `DRFED_CONFIG` or `--config` and mount it into the container.

`docker compose run --rm drfed …` reuses the `drfed` service definition, so
management commands see the same environment, volumes, and database as the
server.  Keep database settings in that service.

The default PGlite data directory is */var/lib/drfed/data*, inside the
*/var/lib/drfed* volume.  The image places it there through `XDG_DATA_HOME`
rather than `DRFED_DATA_PATH`, so setting `DRFED_POSTGRES_URL` alone switches to
PostgreSQL.

[Configuration]: /manual/configuration


PGlite: one process at a time
-----------------------------

Only one process can open a PGlite data directory.  While the server runs,
another command on the same volume fails immediately with exit code 1:

~~~~
Error: locked: The PGlite data directory is already in use by another owner.
~~~~

Running the command through `docker exec` in the server container does not
avoid this.  Create the first account before starting the server, as in the
quick start.  For later maintenance, stop the server first:

~~~~ sh
docker compose stop drfed
docker compose run --rm drfed drfed-account create \
  --email bob@example.com --name "Bob"
docker compose up -d drfed
~~~~


PostgreSQL
----------

For long-running or shared deployments, use PostgreSQL.  It lets you create
accounts and check migrations while DrFed is running.  This example keeps the
database in its own named volume:

<<< ../../docker/compose.postgres.yaml#compose{yaml}

Replace the password in both places and configure a mail transport for login
mail; see [Configuration].  Start both services, then create an account without
stopping DrFed:

~~~~ sh
docker compose up -d
docker compose run --rm drfed drfed-account create \
  --email alice@example.com --name "Alice"
~~~~

Run a single DrFed server per database; multiple server replicas are not
supported.


Migrations
----------

The server applies database migrations when it starts.  To inspect or apply
them without starting the server, run `drfed-migrate` through the same service:

~~~~ sh
docker compose run --rm drfed drfed-migrate --check
docker compose run --rm drfed drfed-migrate
~~~~

`--check` exits with 0 only when the database matches the image's migrations,
and with 1 when it is uninitialized or has pending migrations.  With PGlite,
stop the server first.


A separate frontend
-------------------

`drfed-server` serves the frontend by default.  To run the frontend in its own
container from the same image, layer this file over your *compose.yaml* as
*compose.web.yaml*:

<<< ../../docker/compose.web.yaml#compose{yaml}

~~~~ sh
docker compose -f compose.yaml -f compose.web.yaml up -d
~~~~

The frontend reaches the backend at `http://drfed:8888` on the Compose network.
Plain HTTP to a backend other than loopback needs
`DRFED_ALLOW_INSECURE_BACKEND`, which is safe only on a trusted internal
network.  Set `DRFED_LOGIN_ORIGINS` and `DRFED_PUBLIC_ORIGIN` to the
frontend's public origin.


Data, backups, and upgrades
---------------------------

The image runs as the unprivileged `node` user (UID 1000), which owns
*/var/lib/drfed*.  A new named volume takes that ownership when it is first
mounted.  If you bind-mount a host directory instead, make it writable by
UID 1000.

Data in the volume survives container replacement, including
`docker compose up -d` after an image change.  `docker compose down --volumes`
deletes the volume and every account and instance in it.

To back up a PGlite volume, stop the server and copy the volume to
*drfed-data.tgz*:

<<< ../../docker/backup.sh#backup{sh}

To restore it into a new, empty volume:

<<< ../../docker/restore.sh#restore{sh}

For PostgreSQL, back up and restore the database with [`pg_dump`] and
[`pg_restore`].

To upgrade, back up your data, change the image tag in *compose.yaml*, then
pull the new image and recreate the container.  The server applies new
migrations when it starts:

~~~~ sh
docker compose pull drfed
docker compose up -d drfed
~~~~

With PostgreSQL, check the result with
`docker compose run --rm drfed drfed-migrate --check`; with PGlite, stop the
server first.  To go back to an older version, restore the backup you made
before upgrading.

[`pg_dump`]: https://www.postgresql.org/docs/current/app-pgdump.html
[`pg_restore`]: https://www.postgresql.org/docs/current/app-pgrestore.html


Exposing DrFed to the fediverse
-------------------------------

Publishing the container port is enough for local testing at
`http://drfed.localhost:8888`, but not for federation with remote servers.
Each instance is a subdomain of the root origin, so a public deployment needs:

 -  `DRFED_ROOT_ORIGIN` set to its public origin, such as
    `https://drfed.example.com`.
 -  Wildcard DNS for `*.drfed.example.com` as well as `drfed.example.com`.
 -  HTTPS for both, usually from a reverse proxy.
 -  A reverse proxy that forwards the original `Host` header, because DrFed
    routes requests by the host they arrive on.
 -  A mail transport for login mail instead of `DRFED_MAIL_LOG_CONTENT`.

For example, with [Caddy] and on-demand TLS for instance subdomains:

~~~~
drfed.example.com, *.drfed.example.com {
	tls {
		on_demand
	}
	reverse_proxy 127.0.0.1:8888
}
~~~~

Caddy forwards the original `Host` header by default.  Configure an
[on-demand TLS `ask` endpoint] or use a wildcard certificate through a DNS
challenge.

[Caddy]: https://caddyserver.com/
[on-demand TLS `ask` endpoint]: https://caddyserver.com/docs/automatic-https#on-demand-tls


Image details
-------------

Each release is published as an OCI image index for `linux/amd64` and
`linux/arm64` under these tags:

 -  `X.Y.Z` for every release, such as `0.2.0`.  These tags never move.  Use
    them in deployments.
 -  `latest` for the newest stable release:
    `docker pull ghcr.io/fedify-dev/drfed:latest`.
 -  `next` for the newest prerelease, such as `0.3.0-rc.1`.
 -  `dev` for the newest development build from the `main` branch, which is
    also tagged with its version, such as `0.3.0-dev.123`.

The image is built from the same package tarballs that are published to npm.
Its OCI annotations record the source repository, version, Git revision,
license, base image, and the integrity of each package tarball.  Inspect them
with:

~~~~ sh
docker buildx imagetools inspect --raw ghcr.io/fedify-dev/drfed:latest
~~~~

Every image index also carries a signed build provenance attestation.  Verify
it with the [GitHub CLI]:

~~~~ sh
gh attestation verify oci://ghcr.io/fedify-dev/drfed:latest \
  --repo fedify-dev/drfed
~~~~

The image's build file is *docker/Containerfile* in the repository; any
OCI-compatible runtime can run the image.

[GitHub CLI]: https://cli.github.com/
