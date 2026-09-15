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
 * The shape of a syntactically valid slug: 4 to 63 characters drawn from
 * lowercase letters, digits and hyphens, and starting and ending with a letter
 * or a digit.
 *
 * The bounds on the inner group encode the overall 4–63 length: two anchoring
 * characters plus 2–61 in between.  The upper bound is the maximum length of
 * a DNS label, and the lower bound keeps very short slugs — which are the ones
 * most likely to collide with an operational host name such as `www` or
 * `api` — out of circulation.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,61}[a-z0-9]$/u;

/**
 * Labels whose third and fourth characters are both hyphens.  RFC 5891 § 4.2.3.1
 * reserves the whole class and gives a meaning to exactly one member of it,
 * the `xn--` prefix that introduces a Punycode-encoded A-label.
 */
const RESERVED_LDH_PATTERN = /^..--/u;

/**
 * The prefix of an A-label, i.e. the ASCII-compatible encoding of an
 * internationalized domain name label.
 */
const A_LABEL_PREFIX = "xn--";

/**
 * Checks whether a slug can be used as the leftmost label of an instance's
 * host name.
 *
 * A slug has to be a valid DNS label, because it becomes one: an instance with
 * the slug `foo-bar` is served at `foo-bar.<root domain>`.  That rules out
 * leading and trailing hyphens, which no resolver accepts, and the reserved
 * LDH labels of RFC 5891 — except for `xn--`, which is deliberately allowed so
 * that instances can carry internationalized domain names.  DrFed is a tool for
 * debugging federation, and IDN host names are one of the things that break it.
 *
 * Whether such a label is decodable Punycode is deliberately not checked here.
 * Node answers that out of its bundled ICU, so the answer moves with the
 * runtime, and a rule that accepts a slug on one deployment while rejecting it
 * on another is worse than no rule at all.  `createInstance` instead refuses a
 * slug whose composed host the local runtime cannot parse, which is the thing
 * that actually matters.
 *
 * This duplicates the `local_instances_slug_check` constraint in
 * {@link file://./schema.ts}; the two must be kept in agreement.
 * @param slug The slug to check.
 * @returns `true` if the slug is usable, `false` otherwise.
 */
export function isValidSlug(slug: string): boolean {
  if (!SLUG_PATTERN.test(slug)) return false;
  return !RESERVED_LDH_PATTERN.test(slug) || slug.startsWith(A_LABEL_PREFIX);
}
