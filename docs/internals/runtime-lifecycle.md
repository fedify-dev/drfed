Runtime lifecycle
=================

The application owns database, mail, federation and web resources. Cancellation
requests shutdown; the owner must still wait for accepted work to settle
before closing the resources it uses.


Resource ownership
------------------

Server startup registers each resource as it is acquired.  Startup failures and
shutdown stop new work, drain active requests, GraphQL resolvers and the task
worker, then close owned resources in reverse order.  Cleanup continues if one
resource fails; startup errors retain their original cause.  SIGTERM allows ten
seconds for shutdown and force-closes stalled HTTP connections after five
seconds.

The `@drfed/drfed/resources` and `@drfed/drfed/operations` subpaths export
`ResourceOwner` and `OperationRegistry` for code that manages its own runtime.
Register borrowed resources with `owned: false`; the owner leaves them open.
Operations receive a shared abort signal and remain tracked until their
promises settle.  HTTP response streams in the CLI remain drained by srvx.

The CLI tracks GraphQL work separately from the HTTP handler, as described
under [GraphQL operations](#graphql-operations).

Use `run()` to admit new work and `track()` only for continuations of requests
already accepted.  Stop admitting requests and stop background producers before
calling `drain()`.  Draining also waits for continuations registered during
shutdown, so an accepted GraphQL response can finish during the grace period.


GraphQL operations
------------------

`createYogaServer()` accepts `shutdownSignal` and an optional `trackOperation`
callback. The signal combines runtime shutdown with each request's cancellation
signal and reaches Upyo's send options. A provider may ignore cancellation and
continue after the HTTP response ends.

If the runtime closes database or mail resources on shutdown, supply a
`trackOperation` callback that registers and returns each operation's completion
promise. It tracks context loading and the full execution of field and type
resolvers, including work still running after [Yoga execution cancellation].
The CLI supplies its operation registry; callers that omit the callback must
manage this lifetime themselves. Drain tracked work before closing its
resources.

[Yoga execution cancellation]: https://the-guild.dev/graphql/yoga-server/docs/features/execution-cancellation


Web runtime
-----------

Nitro uses process-wide state, so initialize one runtime per process. A second
initialization is rejected, including after close. `close()` is idempotent,
cancels active GraphQL work and waits for its response bodies to finish before
running Nitro close hooks. An injected GraphQL handler remains caller-owned;
a handler that ignores cancellation can delay close until the caller's deadline.
Vite uses Nitro's in-process development runner so SSR shares the external
binding. Frontend HMR retains it; a Vite config or environment restart installs
a new development binding and drains the previous server's GraphQL work.

See [database lifecycle](database-lifecycle.md) for persistent store ownership
and [HTTP serving](http-serving.md) for the embedded web binding and request
boundaries.
