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

import { message, values } from "@optique/core/message";
import {
  type NonEmptyString,
  type ValueParser,
  ensureNonEmptyString,
} from "@optique/core/valueparser";

/**
 * Options for the {@link origin} value parser.
 */
export interface OriginOptions {
  /**
   * The metavariable name for this parser.  This is used in help messages to
   * indicate what kind of value this parser expects.
   * @default `"ORIGIN"`
   */
  readonly metavar?: NonEmptyString;

  /**
   * List of allowed URL protocols (e.g., `["http:", "https:"]`).  Protocol
   * names must include the trailing colon.  If not specified, any protocol
   * that yields a tuple origin is allowed.
   */
  readonly allowedProtocols?: readonly string[];

  /**
   * Whether to accept an origin whose host is an IP address rather than a
   * domain name.  Set this to `false` when the origin has to be able to take
   * a subdomain, since `foo.127.0.0.1` and `foo.[::1]` are not host names at
   * all.
   * @default `true`
   */
  readonly allowIpLiterals?: boolean;
}

/**
 * A host name that the WHATWG URL parser has canonicalized into a dotted-quad
 * IPv4 address.  Matching the canonical form is enough, because the parser
 * turns every other spelling (`0x7f.1`, `2130706433`, …) into it.
 */
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * Creates a {@link ValueParser} for web origins.
 *
 * The parser accepts any absolute URL and *normalizes* it down to its origin
 * rather than rejecting the extra components, so every one of
 * `HTTPS://Example.COM`, `https://example.com/`, and
 * `https://user:pw@example.com/path?query#fragment` parses to the same
 * `https://example.com`.  Only two kinds of input are rejected: strings that
 * are not absolute URLs at all, and URLs whose protocol is either outside
 * {@link OriginOptions.allowedProtocols} or has no tuple origin (`mailto:`,
 * `data:`, and friends, whose origin is the opaque `"null"`), and, when
 * {@link OriginOptions.allowIpLiterals} is off, origins whose host is an IP
 * address.
 * @param options Configuration options for the origin parser.
 * @returns A {@link ValueParser} that converts string input into `URL`
 *          objects that are guaranteed to equal their own origin.
 */
export function origin(options: OriginOptions = {}): ValueParser<"sync", URL> {
  const metavar = options.metavar ?? "ORIGIN";
  ensureNonEmptyString(metavar);
  let allowedProtocols: readonly string[] | undefined;
  if (options.allowedProtocols != null) {
    if (options.allowedProtocols.length < 1) {
      throw new TypeError("allowedProtocols must not be empty.");
    }
    for (const protocol of options.allowedProtocols) {
      // Without the trailing colon an entry can never match `URL.protocol`,
      // so the parser would reject every input while reporting the rejected
      // protocol as an allowed one.  Fail loudly at construction instead.
      if (!/^[a-z][a-z0-9+\-.]*:$/iu.test(protocol)) {
        throw new TypeError(
          "Each allowed protocol must be a valid protocol ending with " +
            `a colon (e.g., "https:"), got: ${JSON.stringify(protocol)}.`,
        );
      }
    }
    allowedProtocols = Object.freeze(
      options.allowedProtocols.map((protocol) => protocol.toLowerCase()),
    );
  }
  const allowIpLiterals = options.allowIpLiterals ?? true;
  return {
    mode: "sync",
    metavar,
    // A getter, so that every access yields a fresh `URL` that callers may
    // mutate without corrupting the parser.  `.invalid` is reserved by
    // RFC 2606 and can never resolve.
    get placeholder(): URL {
      return new URL(`${allowedProtocols?.[0] ?? "http:"}//0.invalid`);
    },
    parse(input: string) {
      if (!URL.canParse(input)) {
        return {
          success: false,
          error: message`Invalid origin: ${input}.`,
        };
      }
      const url = new URL(input);
      if (
        allowedProtocols != null &&
        !allowedProtocols.includes(url.protocol)
      ) {
        return {
          success: false,
          error: message`URL protocol ${url.protocol} is not allowed.  Allowed protocols: ${values([...allowedProtocols])}.`,
        };
      }
      // `URL.origin` is the string `"null"` for schemes without a tuple
      // origin, which `new URL()` cannot parse back.  Such URLs can never
      // name a host, so they are not origins in any useful sense.
      if (url.origin === "null") {
        return {
          success: false,
          error: message`The URL ${input} has no origin.`,
        };
      }
      // The normalized origin, not `url` itself: a `blob:` URL reports an
      // empty `hostname` while its origin carries the authority embedded in
      // it, so checking the original would miss `blob:http://127.0.0.1/x`.
      const normalized = new URL(url.origin);
      if (
        !allowIpLiterals &&
        (normalized.hostname.startsWith("[") ||
          IPV4_PATTERN.test(normalized.hostname))
      ) {
        return {
          success: false,
          error: message`${input} names an IP address rather than a domain, which cannot take a subdomain.`,
        };
      }
      return { success: true, value: normalized };
    },
    format(value: URL): string {
      return value.origin;
    },
    normalize(value: URL): URL {
      return value.origin === "null" ? value : new URL(value.origin);
    },
  };
}
