Self-hosting
============

Run DrFed on your own server to keep your debugging workspace on your own
infrastructure. See the [CLI reference] for backend configuration options.

[CLI reference]: /reference/cli


Create an account
-----------------

For a deployment running from the repository with the default PGlite database,
create an account before signing in. Start the backend at least once to
initialize *.pgdata/* and run its migrations.

Stop the backend, then run this command from the repository root:

~~~~ sh
mise run generate:account alice@example.com "Alice"
~~~~

Replace the email address and display name with your own. The task creates an
account in *.pgdata/*. If the email address already exists, it leaves the
account unchanged.

Restart the backend, open the frontend, and sign in with that email address.
Follow the login link sent by email, or printed in the backend log when SMTP
is not configured.

The account creation task currently supports only *.pgdata/* in the repository
root. It does not accept a custom PGlite path or a PostgreSQL connection URL.
