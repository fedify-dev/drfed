@drfed/web
==========

SolidStart frontend and embedded Node.js runtime for [DrFed].

[DrFed]: https://drfed.org/


Installed standalone frontend
-----------------------------

Install the application package to obtain the `drfed-web` command:

~~~~ sh
npm install --global @drfed/drfed
drfed-web --backend-url http://localhost:8888 \
  --public-origin https://drfed.example --listen localhost:3000
~~~~

The backend must already be running, and its `--login-origin` allowlist must
include the frontend's public origin. The backend value is normalized to an
origin; requests always use its `/graphql` endpoint. Frontend deployment
settings are resolved at startup and do not require rebuilding the frontend.

All DrFed commands read the same explicit TOML file through `--config FILE` or
`DRFED_CONFIG`, with CLI values overriding environment values and TOML.
`drfed-web` uses `web.public_origin`/`DRFED_PUBLIC_ORIGIN`,
`web.backend_url`/`DRFED_BACKEND_URL` and
`web.listen`/`DRFED_WEB_LISTEN`. Its default listen address is
`localhost:3000`; `server.listen`/`DRFED_LISTEN` belongs to the backend.
The common `telemetry` settings control logging. Database and mail sections are
unused by this command. `--print-config` explains effective settings and sources
without starting the runtime or opening log files.


Development and builds
----------------------

Run `mise run dev` from the repository root to start both development servers.
`mise run dev:web` starts only Vite; its GraphQL backend must already be
running. Development uses `DRFED_BACKEND_URL` (default
`http://drfed.localhost:8888`) and `DRFED_PUBLIC_ORIGIN` (default
`http://localhost:3000`). Add the public origin to the backend's login
allowlist when using a different origin.

Run `mise run build:web` to build the Node adapter, shared binding, SSR bundle
and static assets. `mise run build:web-runtime` builds just the adapter and
binding for Vite development.


Embedded runtime
----------------

Initialize the web runtime with a public origin and GraphQL handler:

~~~~ ts
import { createWebRuntime } from "@drfed/web";

const web = await createWebRuntime({
  publicOrigin: new URL("https://drfed.example"),
  graphqlFetch: (request) => yoga.fetch(request),
});

const response = await web.fetch(request);
await web.close();
~~~~

Importing the package and creating the runtime open no listening socket or
process signal/error handlers. `fetch()` serves SSR, server functions and
bundled assets. Initialize only one runtime per process, including after close;
`close()` is idempotent and the injected GraphQL handler remains caller-owned.
See [runtime lifecycle internals] for cancellation, draining
and HMR, and [HTTP serving internals] for the shared binding,
request validation and cookie policy.

[runtime lifecycle internals]: https://drfed.org/internals/runtime-lifecycle
[HTTP serving internals]: https://drfed.org/internals/http-serving


Request and cookie policy
-------------------------

Use a Host-preserving proxy and configure the external public origin. The web
runtime ignores forwarded headers. Server functions require a same-origin POST;
session cookies are HttpOnly, SameSite=Lax and host-only, with Secure following
the configured HTTPS origin. See the
[full request policy]
for authority errors and validation before body deserialization.

[full request policy]: https://drfed.org/internals/http-serving#request-and-cookie-policy


Verification
------------

`mise run test:web-runtime` checks SSR, static assets, binding identity,
controlled GraphQL headers, cancellation, idempotent draining close and the
absence of listeners or process-handler changes. `mise run test` includes this
test after building the frontend. `mise run test:packaging` also exercises the
runtime from local and global npm tarball installations.


Combined serving
----------------

`drfed-server --root-origin https://drfed.example.com` serves this frontend
and `/graphql` on its single listener. The web runtime calls Yoga directly in
that process, using the same controlled GraphQL bridge as standalone mode.
Use `--no-web` with explicit backend login origins when running `drfed-web`
separately. Repository `mise run dev` uses this split mode for Vite HMR.


Standalone backend security
---------------------------

`drfed-web` requires HTTPS for non-loopback backends because requests carry
session tokens. HTTP is allowed for `localhost`, its subdomains, IPv4
loopback addresses and `::1`. For a trusted internal network, explicitly use
`--allow-insecure-backend`, `DRFED_ALLOW_INSECURE_BACKEND=true`, or
`web.allow_insecure_backend = true` in TOML. This permits unencrypted session
tokens and logs a warning at startup. `--no-allow-insecure-backend` overrides
permission from the environment or configuration file.
