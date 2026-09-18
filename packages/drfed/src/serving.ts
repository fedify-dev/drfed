// DrFed: A web-based platform for developing and debugging ActivityPub apps
// Copyright (C) 2026 DrFed team
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { canonicalizeAuthority, classifyHost } from "@drfed/graphql/origin";
import type { Database } from "@drfed/models";
import { getLogger } from "@logtape/logtape";

/**
 * The part of a Fedify `Federation` that the router needs, narrowed so that
 * the routing can be exercised without building one.
 */
export interface FederationHandler {
  fetch(
    request: Request,
    options: {
      onNotFound(request: Request): Response | Promise<Response>;
      onNotAcceptable(request: Request): Response | Promise<Response>;
      contextData: undefined;
    },
  ): Promise<Response>;
}

/**
 * Options for {@link createFetchHandler}.
 */
export interface FetchHandlerOptions {
  /**
   * The root origin this deployment serves instances under.
   */
  readonly rootOrigin: URL;

  /**
   * The ActivityPub surface, served on instance subdomains.
   */
  readonly federation: FederationHandler;

  /**
   * The control surface, i.e. the GraphQL server, served everywhere else.
   */
  readonly serveControlSurface: (
    request: Request,
  ) => Response | Promise<Response>;
}

/**
 * Builds the server's request handler, which decides from the authority alone
 * which of DrFed's two faces answers.
 *
 * An instance's subdomain serves ActivityPub and nothing else, so that a
 * tenant can never reach the control surface; every other authority is the
 * control surface and never answers as an instance.  A subdomain nobody has
 * claimed still routes to ActivityPub, where every dispatcher resolves to
 * nothing and the request ends in a 404, which keeps the routing from having
 * to ask the database what exists.
 * @param options The surfaces to route between, and the root origin to route
 *                by.
 * @returns A handler suitable for passing to `serve()`.
 */
export function createFetchHandler(
  options: FetchHandlerOptions,
): (request: Request) => Promise<Response> {
  const { federation, rootOrigin, serveControlSurface } = options;
  return async (request: Request): Promise<Response> => {
    // A server adapter may accept a `Host` that `URL` will not.  srvx checks
    // it against a structural pattern and builds the request URL by
    // concatenation, so `1.2.3.4.5`, `999.1.1.1` and undecodable A-labels such
    // as `xn--a` all arrive here as URLs that cannot be parsed.  Parsing one
    // throws inside this handler, and srvx attaches no rejection handler, so
    // the process would die on a single unauthenticated request.
    if (!URL.canParse(request.url)) return invalidHost();
    const url = new URL(request.url);
    // An adapter may also substitute something for a `Host` it cannot make
    // sense of rather than refuse the request: srvx uses the literal
    // `_invalid_`, which does parse.  Routing on that would quietly hand the
    // control surface to a request that was aiming at a tenant.
    const host = request.headers.get("host");
    if (
      host != null &&
      canonicalizeAuthority(host) !== canonicalizeAuthority(url.host)
    ) {
      return invalidHost();
    }
    switch (classifyHost(url, rootOrigin)) {
      case "instance":
        return await federation.fetch(request, {
          onNotFound: notFound,
          onNotAcceptable: notFound,
          contextData: undefined,
        });
      case "misdirected":
        // Below the root domain but deeper than the single label an instance
        // occupies, so nothing here will ever answer.  Saying so is more use
        // to whoever misconfigured the DNS than a bare 404 would be.
        return misdirected();
      default:
        return await serveControlSurface(request);
    }
  };
}

function notFound(): Response {
  return new Response("Not found.", {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status: 404,
  });
}

function invalidHost(): Response {
  // RFC 9110 section 7.2 asks for 400 when the Host field value is invalid,
  // which covers both a host `URL` rejects and one the adapter replaced.
  return new Response("Bad request: invalid Host header.", {
    headers: { "content-type": "text/plain; charset=utf-8" },
    status: 400,
  });
}

function misdirected(): Response {
  return new Response(
    "Misdirected request: this server does not serve that host.",
    {
      headers: { "content-type": "text/plain; charset=utf-8" },
      status: 421,
    },
  );
}

/**
 * Finds local instances whose host does not sit one label below the given root
 * origin, which is what happens when a deployment's root origin is changed
 * after instances already exist.
 * @param db The database to look in.
 * @param rootOrigin The configured root origin.
 * @returns The hosts that are no longer reachable, in no particular order.
 */
export async function findStrandedInstances(
  db: Database,
  rootOrigin: URL,
): Promise<string[]> {
  const instances = await db.query.instances.findMany({
    columns: { host: true },
    where: { localId: { isNotNull: true } },
  });
  return instances
    .map(({ host }) => host)
    .filter((host) => {
      // A stored host need not be a parseable authority at all: an older,
      // laxer rule may have let one through, and whether a given host parses
      // can even move with the runtime's ICU.  A startup check is the last
      // place that should throw over it.
      const url = `${rootOrigin.protocol}//${host}`;
      if (!URL.canParse(url)) return true;
      return classifyHost(new URL(url), rootOrigin) !== "instance";
    });
}

/**
 * Warns about local instances the configured root origin no longer covers.
 *
 * Nothing is repaired.  An instance's host is woven into the actor URIs that
 * the rest of the fediverse has already seen and stored, so rewriting it would
 * break exactly the federation it was meant to fix.  Say what is wrong, and
 * leave the decision to a human.
 * @param db The database to look in.
 * @param rootOrigin The configured root origin.
 */
export async function warnAboutStrandedInstances(
  db: Database,
  rootOrigin: URL,
): Promise<void> {
  const stranded = await findStrandedInstances(db, rootOrigin);
  if (stranded.length < 1) return;
  logger.warn(
    "{count} local instance(s) are hosted outside the configured root " +
      "origin {rootOrigin}, and are no longer reachable: {hosts}.  Their " +
      "actor URIs already name those hosts, so nothing has been changed.",
    { count: stranded.length, hosts: stranded, rootOrigin: rootOrigin.origin },
  );
}

const logger = getLogger(["drfed", "instances"]);
