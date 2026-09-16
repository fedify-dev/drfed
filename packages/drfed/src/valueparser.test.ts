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

import assert from "node:assert/strict";

import { rootOrigin } from "@drfed/drfed/valueparser";
import { describe, it } from "@logtape/testing-node/autoload";

const parser = rootOrigin();

function parse(input: string) {
  return parser.parse(input);
}

function parsed(input: string): string {
  const result = parse(input);
  assert.ok(result.success, `expected ${input} to parse`);
  return result.value.origin;
}

describe("rootOrigin()", () => {
  // Normalization is Optique's; these cases pin the behaviour this deployment
  // option depends on rather than re-testing the library.
  it("normalizes spellings of the same origin", () => {
    for (const input of [
      "https://drfed.net",
      "https://drfed.net/",
      "HTTPS://DrFed.NET",
      "https://drfed.net/path?query=1#fragment",
      "https://drfed.net:443/",
      "https://drfed.net.",
    ]) {
      assert.equal(parsed(input), "https://drfed.net", input);
    }
  });

  it("keeps a non-default port", () => {
    assert.equal(
      parsed("http://drfed.localhost:8888"),
      "http://drfed.localhost:8888",
    );
    assert.equal(parsed("http://drfed.net:80/"), "http://drfed.net");
  });

  it("accepts only HTTP and HTTPS", () => {
    assert.equal(parsed("http://drfed.net"), "http://drfed.net");
    assert.equal(parse("ftp://drfed.net").success, false);
    assert.equal(parse("mailto:someone@drfed.net").success, false);
  });

  it("rejects input that is not an absolute URL", () => {
    for (const input of ["", "drfed.net", "/path", "https://"]) {
      assert.equal(parse(input).success, false, input);
    }
  });

  it("rejects credentials rather than stripping them", () => {
    // Asserted on the parse path as well as the validate one, because the two
    // reach the wrapped parser by different routes and only the DrFed rules
    // are shared between them.
    assert.equal(parse("https://user:pw@drfed.net/").success, false);
  });

  // The two rules below are DrFed's own, not Optique's.
  it("rejects an IP address, which cannot take a subdomain", () => {
    for (const input of [
      "http://127.0.0.1:8888",
      "http://[::1]:8888",
      "http://[2001:db8::1]",
      // The URL parser canonicalizes every other IPv4 spelling into the
      // dotted quad, so these name the same host as 127.0.0.1.
      "http://0x7f.1",
      "http://2130706433",
    ]) {
      assert.equal(parse(input).success, false, input);
    }
    // A name that merely begins with digits is still a name.
    assert.equal(parsed("https://1.drfed.net"), "https://1.drfed.net");
  });

  it("rejects a host name longer than a domain name may be", () => {
    // 253 octets is the limit, and the mail library refuses to build a message
    // whose sender domain exceeds it, so accepting one here would only defer
    // the failure to every login attempt.
    const label = "a".repeat(63);
    const longest = [label, label, label, "a".repeat(61)].join(".");
    assert.equal(longest.length, 253);
    assert.equal(parsed(`https://${longest}`), `https://${longest}`);
    assert.equal(parse(`https://${longest}a`).success, false);
    // The root zone's dot is stripped before the length is measured.
    assert.equal(parsed(`https://${longest}.`), `https://${longest}`);
  });

  it("offers a placeholder that is a fresh value each time", () => {
    // Spreading the wrapped parser would have frozen one shared `URL` here.
    const first = parser.placeholder;
    const second = parser.placeholder;
    assert.notEqual(first, second);
    assert.equal(first.href, second.href);
  });

  it("validates a fallback value as strictly as it parses one", () => {
    // Optique checks a value that came from somewhere other than the command
    // line, such as an environment variable, through `validate()`.  Without
    // it the check falls back to `format()` then `parse()`, and `format()`
    // emits only the origin, so a value carrying credentials would be
    // laundered into an accepted one.
    assert.ok(parser.validate);
    for (const [input, valid] of [
      ["https://drfed.net/", true],
      ["http://drfed.localhost:8888/", true],
      // Rejected by the wrapped parser.
      ["https://u:p@drfed.net/", false],
      ["ftp://drfed.net/", false],
      // Rejected by the two rules this wrapper adds.
      ["http://127.0.0.1:8888/", false],
      [
        `https://${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(62)}/`,
        false,
      ],
    ] as const) {
      assert.equal(parser.validate(new URL(input)).success, valid, input);
    }
  });

  it("round-trips through format() and normalize()", () => {
    const result = parse("https://drfed.net/path");
    assert.ok(result.success);
    assert.equal(parser.format(result.value), "https://drfed.net");
    assert.equal(
      parser.normalize?.(new URL("https://drfed.net/path")).href,
      "https://drfed.net/",
    );
  });

  it("uses ORIGIN as the default metavar", () => {
    assert.equal(rootOrigin().metavar, "ORIGIN");
    assert.equal(rootOrigin({ metavar: "ROOT" }).metavar, "ROOT");
  });
});
