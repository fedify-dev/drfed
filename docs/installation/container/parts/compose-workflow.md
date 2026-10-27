Quick start
-----------

Save this file as *compose.yaml* in an empty directory:

<<< @/../docker/compose.pglite.yaml#compose{yaml}

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

`docker compose run --rm drfed drfed-migrate --check` runs `drfed-migrate`
instead of the server; see [how the image runs commands].  `run --rm` reuses
the `drfed` service definition, so management commands see the same
environment, volumes, and database as the server.  Keep database settings in
that service.

[how the image runs commands]: /installation/container/#commands


PGlite maintenance
------------------

Only one process can open a PGlite data directory; see
[PGlite: one process at a time].  Create the first account before starting the
server, as in the quick start.  For later maintenance, stop the server first:

~~~~ sh
docker compose stop drfed
docker compose run --rm drfed drfed-account create \
  --email bob@example.com --name "Bob"
docker compose up -d drfed
~~~~

[PGlite: one process at a time]: /installation/container/#pglite-one-process-at-a-time


PostgreSQL
----------

For long-running or shared deployments, use PostgreSQL.  It lets you create
accounts and check migrations while DrFed is running.  This example keeps the
database in its own named volume:

<<< @/../docker/compose.postgres.yaml#compose{yaml}

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

[Configuration]: /manual/configuration


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

<<< @/../docker/compose.web.yaml#compose{yaml}

~~~~ sh
docker compose -f compose.yaml -f compose.web.yaml up -d
~~~~

The frontend reaches the backend at `http://drfed:8888` on the Compose network.
Plain HTTP to a backend other than loopback needs
`DRFED_ALLOW_INSECURE_BACKEND`, which is safe only on a trusted internal
network.  Set `DRFED_LOGIN_ORIGINS` and `DRFED_PUBLIC_ORIGIN` to the
frontend's public origin.


Backups and upgrades
--------------------

Data in the volume survives container replacement, including
`docker compose up -d` after an image change.  `docker compose down --volumes`
deletes the volume and every account and instance in it.

To back up a PGlite volume, stop the server and copy the volume to
*drfed-data.tgz*:

<<< @/../docker/backup.sh#backup{sh}

To restore it into a new, empty volume:

<<< @/../docker/restore.sh#restore{sh}

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
