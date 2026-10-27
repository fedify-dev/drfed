HTTP serving
============

The CLI combines ActivityPub, GraphQL and the frontend on one listener.
`@drfed/federation/origin` owns instance-host composition and classification;
*packages/drfed/src/serving.ts* routes requests using those rules.


Authority routing
-----------------

Requests are routed by the authority they arrive on:

| Authority                             | Serves                                |
| ------------------------------------- | ------------------------------------- |
| `<slug>.<root domain>`                | ActivityPub only; GraphQL answers 404 |
| the public web authority              | Frontend and exact `/graphql`         |
| other control authorities             | Exact `/graphql`; web paths are 421   |
| anything deeper under the root domain | 421 Misdirected Request               |
| an unusable `Host` header             | 400 Bad Request                       |

The authority has to match in full, port included.  A request for
`foo.drfed.example.com:8888` against a root origin of
`https://drfed.example.com` does not name an instance and is served the control
surface, not a 404, so do not read the table above as isolating GraphQL by host
name alone.  Ports 80 and 443 both count as no port at all, since which of them
is the default depends on a scheme that is deliberately not compared.

The reverse proxy contract preserves the original `Host` header.
Set the root origin's external scheme for federation and the public web
origin's external scheme for the frontend. The server restores those schemes
before handing requests to Fedify or SolidStart; it ignores forwarded headers.
`X-Forwarded-Host` cannot select an instance or frontend. Proxies that replace
`Host` are unsupported. A trailing-dot Host may be refused by srvx before the
DrFed router runs.


Embedded web binding
--------------------

Importing the package and creating the runtime open no listening socket or
process signal/error handlers. `fetch()` serves SolidStart SSR, server functions
and bundled static assets. Deployment settings live in one external Node module
shared by the adapter and Nitro bundle, rather than argv or serialized runtime
configuration. Each server-side Relay request reads its own SolidStart request
context and forwards only a validated session token as Bearer authorization.
Other cookies and incoming authorization/proxy headers are not forwarded.

The [Nitro configuration] controls the listener-free Node entry and external
binding. [Solid's request context] supplies the request cancellation signal.
See [runtime lifecycle](runtime-lifecycle.md#web-runtime) for singleton state,
HMR and close behavior.

[Nitro configuration]: https://nitro.build/docs/configuration
[Solid's request context]: https://docs.solidjs.com/reference/server-utilities/get-request-event


Request and cookie policy
-------------------------

Serve the web app only through the configured public origin's authority.
The runtime applies the reverse proxy contract above and strips forwarded
headers. A different authority receives 421;
malformed or inconsistent URL/Host values receive 400.

[Server functions] accept POST only, with an Origin matching the public origin.
When Origin is absent, a same-origin Referer is required. Missing, opaque,
malformed and cross-origin sources are rejected before body deserialization;
instance subdomains are also cross-origin. The same policy runs in embedded
and development servers, including encoded server-function path aliases.
Regular login-link GET pages still render, while confirmation uses POST.

Session cookies use HttpOnly, SameSite=Lax and path `/`, without Domain.
Secure follows the configured public origin's HTTPS scheme, including behind
TLS termination; forwarded headers cannot downgrade it.

[Server functions]: https://docs.solidjs.com/solid-start/v2/guides/security#csrf-cross-site-request-forgery


Combined serving
----------------

Combined serving calls Yoga directly through the controlled GraphQL bridge;
standalone serving uses HTTP. See the [web package README] for deployment
commands and the split development setup.

Configuration values enter these runtimes through the
[shared configuration bindings](configuration-resolution.md). Deployment
requirements and flags remain in the [CLI reference](../reference/cli.md).

[web package README]: https://github.com/fedify-dev/drfed/tree/main/packages/web#combined-serving
