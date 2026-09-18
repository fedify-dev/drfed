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

import { message } from "@optique/core/message";
import {
  type NonEmptyString,
  type ValueParser,
  type ValueParserResult,
  ensureNonEmptyString,
  origin,
} from "@optique/core/valueparser";

/**
 * A host name that the WHATWG URL parser has canonicalized into a dotted-quad
 * IPv4 address.  Matching the canonical form is enough, because the parser
 * turns every other spelling (`0x7f.1`, `2130706433`, …) into it.
 */
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * The greatest length a domain name may have, in octets.
 */
const MAX_HOSTNAME_LENGTH = 253;

/**
 * Options for the {@link rootOrigin} value parser.
 */
export interface RootOriginOptions {
  /**
   * The metavariable name for this parser.  This is used in help messages to
   * indicate what kind of value this parser expects.
   * @default `"ORIGIN"`
   */
  readonly metavar?: NonEmptyString;
}

/**
 * Applies the two rules that are DrFed's own to an origin the wrapped parser
 * has already accepted, so that `parse()` and `validate()` cannot come to
 * different conclusions about the same value.
 * @param result The inner parser's successful result.
 * @param input What to name in an error message.
 * @returns The result unchanged, or a failure explaining which rule it broke.
 */
function check(
  result: { readonly success: true; readonly value: URL },
  input: string,
): ValueParserResult<URL> {
  const { hostname } = result.value;
  if (hostname.startsWith("[") || IPV4_PATTERN.test(hostname)) {
    return {
      success: false,
      error: message`${input} names an IP address rather than a domain, which cannot take a subdomain.`,
    };
  }
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    return {
      success: false,
      error: message`The host name of ${input} is longer than the ${String(MAX_HOSTNAME_LENGTH)} characters a domain name may have.`,
    };
  }
  return result;
}

/**
 * Creates a {@link ValueParser} for the origin a DrFed deployment is served
 * from.
 *
 * Parsing and normalization are Optique's `origin()`: the input is canonical-
 * ized rather than rejected, so `HTTPS://DrFed.NET/` and
 * `https://drfed.net:443/path` both come out as `https://drfed.net`, and the
 * root zone's trailing dot is stripped.  Only HTTP and HTTPS are accepted.
 *
 * Two further constraints are DrFed's own, because this origin is not just any
 * origin.  Every instance is a subdomain of it, and `foo.127.0.0.1` is not a
 * host name at all, so an IP address is refused.  Login mail is sent from
 * `noreply@` at its host name, and the mail library will not build a message
 * whose domain runs past the 253 octets DNS allows, so a longer host is
 * refused too.  Both are caught here, at the boundary, rather than surfacing
 * later as an instance nobody can address or a login that never arrives.
 * @param options Configuration options for the parser.
 * @returns A {@link ValueParser} producing the deployment's root origin.
 */
export function rootOrigin(
  options: RootOriginOptions = {},
): ValueParser<"sync", URL> {
  const metavar = options.metavar ?? "ORIGIN";
  ensureNonEmptyString(metavar);
  const inner = origin({
    allowedProtocols: ["http:", "https:"],
    metavar,
  });
  return {
    mode: "sync",
    metavar,
    // Delegated one member at a time rather than spread: `placeholder` is a
    // getter on the parser being wrapped, and spreading would call it once and
    // hand every caller the same mutable `URL`.
    get placeholder(): URL {
      return inner.placeholder;
    },
    parse(input: string) {
      const result = inner.parse(input);
      return result.success ? check(result, input) : result;
    },
    // Optique validates a fallback value, such as one from an environment
    // variable, through this rather than through `parse()`.  Without it the
    // check degrades to `format()` followed by `parse()`, and since `format()`
    // emits only the origin, a value carrying credentials would be laundered
    // into an accepted one.
    validate(value: URL) {
      const result = inner.validate?.(value) ?? { success: true, value };
      return result.success ? check(result, value.href) : result;
    },
    format(value: URL): string {
      return inner.format(value);
    },
    normalize(value: URL): URL {
      return inner.normalize?.(value) ?? value;
    },
    suggest(prefix: string) {
      return inner.suggest?.(prefix) ?? [];
    },
  };
}
