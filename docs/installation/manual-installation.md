Manual installation
===================

Run DrFed on your own server to develop and debug ActivityPub apps.

To run DrFed without installing Node.js, use the official container image; see
[Container image].

[Container image]: /installation/container/


Install from npm
----------------

Install Node.js 26 or newer, then install [DrFed from npm] in a directory
where you want to run it:

~~~~ sh
npm install @drfed/drfed
~~~~

The package provides `drfed-server`, `drfed-account`, `drfed-migrate`, and
`drfed-web`. Use `npx` to run these commands from the installation directory.

[DrFed from npm]: https://www.npmjs.com/package/@drfed/drfed


Create an account and start DrFed
---------------------------------

Create your account before starting the server:

~~~~ sh
npx drfed-account create --data-path .pgdata \
  --email alice@example.com --name "Alice"
~~~~

Replace the email address and display name with your own. The command prepares
the database in *.pgdata/*. Start DrFed with the same data directory:

~~~~ sh
npx drfed-server --root-origin http://drfed.localhost:8888 \
  --data-path .pgdata --mail-log-content
~~~~

Open `http://drfed.localhost:8888` and sign in with your email address. This
local example prints the login link in the server log. Follow it to finish
signing in. The server includes the web frontend and stores your data in
*.pgdata/*. Press `Ctrl+C` to stop it.

For a public deployment, configure your domain, wildcard DNS for instance
subdomains, HTTPS, and a mail delivery transport. See [Configuration] and
[Self-hosting] for settings, account creation, and database maintenance.

[Configuration]: /manual/configuration
[Self-hosting]: /manual/self-hosting


Other installation options
--------------------------

To make the commands available directly on your `PATH`, install globally:

~~~~ sh
npm install --global @drfed/drfed
~~~~

Then run `drfed-server` and the other commands without `npx`.
To build DrFed yourself, see [Run from source].

[Run from source]: /installation/run-from-source
