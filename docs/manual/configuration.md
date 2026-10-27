Configuration
=============

DrFed accepts command-line options, `DRFED_*` environment variables, and an
explicit TOML configuration file. `drfed-server`, `drfed-account`,
`drfed-migrate`, and `drfed-web` share these settings, using the sections
relevant to each command.


Select a configuration file
---------------------------

Create *drfed.toml*:

~~~~ toml
[server]
root_origin = "http://drfed.localhost:8888"
listen = "localhost:8888"

[database]
data_path = ".pgdata"
migrate = true

[mail]
transport = "logtape"

[telemetry]
log_level = "info"
~~~~

Select it explicitly when starting the server:

~~~~ sh
drfed-server --config drfed.toml
~~~~

From a built repository, use `mise run drfed-server --config drfed.toml`.
You can also select the file with `DRFED_CONFIG`. DrFed does not search for
configuration files or load *.env* files automatically. The repository's
development task has its own environment-file loading.


Override a setting
------------------

Settings use this precedence, from highest to lowest:

1.  Command-line options.
2.  `DRFED_*` environment variables.
3.  The selected TOML file.
4.  Defaults.

For example, `--listen localhost:9000` overrides `server.listen` in the file.
Login origins in the environment must be a JSON array:

~~~~ sh
DRFED_LOGIN_ORIGINS='["http://drfed.localhost:8888", "https://drfed.example.com"]' \
  drfed-server --config drfed.toml
~~~~

The list includes the embedded frontend's public origin from the example
configuration, which is required when the frontend is enabled.

Relative paths in TOML resolve against the configuration file's directory.
Paths supplied through CLI options or environment variables resolve against
the command's working directory. Unknown TOML fields are rejected.


Server and database settings
----------------------------

| TOML setting           | Environment variable  | Purpose                                     |
| ---------------------- | --------------------- | ------------------------------------------- |
| `server.root_origin`   | `DRFED_ROOT_ORIGIN`   | Origin whose subdomains serve instances.    |
| `server.listen`        | `DRFED_LISTEN`        | Backend listening address.                  |
| `server.login_origins` | `DRFED_LOGIN_ORIGINS` | Allowed frontend origins for login links.   |
| `server.web`           | `DRFED_WEB`           | Enable the embedded frontend.               |
| `database.data_path`   | `DRFED_DATA_PATH`     | PGlite storage directory.                   |
| `database.url`         | `DRFED_POSTGRES_URL`  | PostgreSQL connection URL.                  |
| `database.migrate`     | `DRFED_MIGRATE`       | Apply pending migrations on server startup. |

The embedded frontend is enabled by default, and login origins default to its
public origin. A backend started with `--no-web` requires explicit login
origins. Use `web.public_origin` or `--public-origin` to choose a frontend
origin different from the root origin.

Choose either `database.data_path` or `database.url` at the same input source.
A higher-priority database selector replaces a lower-priority selector. With
neither set, DrFed uses PGlite in its default persistent OS data directory.

The official container image sets `DRFED_CONTAINER=1`.  This marker is not a
setting: it only changes the default listening host of `drfed-server` and
`drfed-web` to `0.0.0.0`, so every configured listen address still replaces it.
The image also sets `XDG_DATA_HOME=/var/lib`, which places the default PGlite
directory at */var/lib/drfed/data*.  See [Docker].

[Docker]: /installation/docker


Deliver login email
-------------------

The default `logtape` transport records mail events without delivering mail.
It excludes message contents. For local testing, use `--mail-log-content` to
include login links in the log.

For SMTP delivery, add settings such as:

~~~~ toml
[mail]
transport = "smtp"
from = "noreply@drfed.example.com"

[mail.smtp]
host = "smtp.example.com"
port = 587
tls = "starttls-required"
user = "operator"
password_file = "secrets/smtp-password"
~~~~

The password file path is relative to the TOML file. Configure your mail
provider to accept the sender address. SMTP also supports direct TLS and
OAuth credentials. Other transports include JMAP, Lettermint, Maileroo,
Mailtrap, Mailgun, Plunk, Resend, SendGrid, and Amazon SES. See the
[server package README] for their settings and credential-file rules.

[server package README]: https://github.com/fedify-dev/drfed/blob/main/packages/drfed/README.md


Inspect the effective configuration
-----------------------------------

~~~~ sh
drfed-server --config drfed.toml --print-config
~~~~

This prints JSON with the selected settings and their sources, with secrets
redacted. It exits without opening the database, mail transport, or log file.
Use it to check which source supplied a setting before starting the server.
