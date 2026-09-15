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

/**
 * What a DrFed server should do with a request, decided from the authority it
 * arrived on.
 *
 * - `"instance"`: the authority names an instance hosted by this deployment,
 *   so the request belongs to that instance's ActivityPub surface.  It may
 *   still be an instance nobody has created, in which case every dispatcher
 *   resolves to nothing and the request ends in a 404.
 * - `"admin"`: the authority is the root origin itself, or an address the
 *   deployment is reachable on without naming an instance, such as the
 *   listening socket or an internal name a reverse proxy uses.  The request
 *   belongs to the control surface, i.e. GraphQL.
 * - `"misdirected"`: the authority sits under the root domain but cannot name
 *   an instance, because instances occupy exactly one label below it.  Nothing
 *   here will ever answer, and saying so is more useful than a 404.
 */
export type HostKind = "instance" | "admin" | "misdirected";

/**
 * Composes the authority an instance is federated under.
 *
 * The root origin contributes its authority rather than its host name, so a
 * deployment that is not on its scheme's default port carries that port into
 * every instance: with a root origin of `http://drfed.localhost:8888`, the
 * slug `foo-bar` yields `foo-bar.drfed.localhost:8888`.  That is deliberate,
 * because this value has to equal Fedify's `Context.host` for the federation
 * dispatchers to find the instance.  For the same reason the root zone's
 * trailing dot is stripped, so that a root origin given as `https://drfed.net.`
 * yields the same authority as `https://drfed.net`.
 * @param rootOrigin The root origin of this deployment.
 * @param slug The slug of the instance.
 * @returns The value to store in `instances.host`.
 */
export function instanceHost(rootOrigin: URL, slug: string): string {
  return `${slug}.${canonicalAuthority(rootOrigin)}`;
}

/**
 * Composes the absolute origin an instance is served at.
 * @param rootOrigin The root origin of this deployment.
 * @param slug The slug of the instance.
 * @returns The instance's origin, e.g. `https://foo-bar.drfed.net`.
 */
export function instanceOrigin(rootOrigin: URL, slug: string): URL {
  return new URL(`${rootOrigin.protocol}//${instanceHost(rootOrigin, slug)}`);
}

/**
 * Decides what a request is for from the authority it arrived on.
 *
 * Only the authority is compared, never the scheme.  A deployment behind a
 * TLS-terminating reverse proxy sees plain HTTP requests even though its root
 * origin is HTTPS, and refusing those would break every such deployment.
 *
 * The port is part of the comparison, because it is part of the authority
 * instances are federated under.  A request that reaches the same host name on
 * some other port has not named an instance, and is treated as reaching the
 * control surface.
 * @param url The URL of the incoming request.
 * @param rootOrigin The root origin of this deployment.
 * @returns What the request should be served from.
 */
export function classifyHost(url: URL, rootOrigin: URL): HostKind {
  // Compared apart from the host name, so that an IPv6 literal — which keeps
  // its brackets in `URL.hostname` — needs no special handling here.
  if (canonicalPort(url) !== canonicalPort(rootOrigin)) return "admin";
  const hostname = canonicalHostname(url);
  const root = canonicalHostname(rootOrigin);
  if (hostname === root) return "admin";
  const suffix = `.${root}`;
  if (!hostname.endsWith(suffix)) return "admin";
  const label = hostname.slice(0, -suffix.length);
  // Exactly one non-empty label below the root domain is an instance;
  // anything deeper, or an empty label, can never name one.
  return label !== "" && !label.includes(".") ? "instance" : "misdirected";
}

/**
 * Strips the root zone's trailing dot from a host name.
 *
 * `example.com.` and `example.com` name the same host, but the WHATWG URL
 * parser keeps the dot, so comparing host names without stripping it would
 * classify a request for `foo.drfed.net.` as though it had nothing to do with
 * `drfed.net` at all.
 * @param url The URL to read the host name from.
 * @returns The host name without its root-zone dot.
 */
export function canonicalHostname(url: URL): string {
  const { hostname } = url;
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * The port of a URL, with both of the web's default ports read as "default".
 *
 * `URL.port` is empty only when the port is the default *for that URL's
 * scheme*, so `http://example.com:443` keeps its `443` while
 * `https://example.com:443` does not.  Comparing the raw values would let the
 * scheme back into a comparison that deliberately ignores it: a deployment
 * behind a TLS-terminating proxy sees `http://…:443` for a request a client
 * addressed to the https default port, and that names the same authority as
 * `https://…` with no port at all.
 * @param url The URL to read the port from.
 * @returns The port, or the empty string when it is a default one.
 */
function canonicalPort(url: URL): string {
  const { port } = url;
  return port === "80" || port === "443" ? "" : port;
}

/**
 * The authority of a URL with {@link canonicalHostname} applied, i.e. the host
 * name without its root-zone dot, followed by the port when it is not the
 * scheme's default.
 * @param url The URL to read the authority from.
 * @returns The canonical authority.
 */
function canonicalAuthority(url: URL): string {
  const hostname = canonicalHostname(url);
  const port = canonicalPort(url);
  return port === "" ? hostname : `${hostname}:${port}`;
}

/**
 * Canonicalizes an authority that arrived as a bare string, the way
 * {@link instanceHost} composes one.
 *
 * Fedify reports `Context.host` verbatim from the request, so it may carry
 * spellings that name the instance without matching the stored `host`: a
 * root-zone dot, or a default port a client wrote out.  Normalizing both sides
 * is what lets such a request reach its instance instead of a 404.
 * @param authority The authority to canonicalize.
 * @returns The canonical spelling, or the input unchanged if it is not an
 *          authority at all.
 */
export function canonicalizeAuthority(authority: string): string {
  const url = `https://${authority}`;
  return URL.canParse(url) ? canonicalAuthority(new URL(url)) : authority;
}
