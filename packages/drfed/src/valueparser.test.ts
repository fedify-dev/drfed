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

import { origin } from "@drfed/drfed/valueparser";
import { describe, it } from "@logtape/testing-node/autoload";

function parse(input: string, options?: Parameters<typeof origin>[0]) {
  return origin(options).parse(input);
}

function parsed(input: string, options?: Parameters<typeof origin>[0]): string {
  const result = parse(input, options);
  assert.ok(result.success, `expected ${input} to parse`);
  return result.value.origin;
}

describe("origin()", () => {
  it("normalizes anything that reduces to the same origin", () => {
    for (const input of [
      "https://example.com",
      "https://example.com/",
      "HTTPS://Example.COM",
      "https://example.com/path/to/thing",
      "https://example.com/?query=1#fragment",
      "https://user:pw@example.com/",
      "https://example.com:443/",
    ]) {
      assert.equal(parsed(input), "https://example.com");
    }
  });

  it("keeps a non-default port", () => {
    assert.equal(
      parsed("http://drfed.localhost:8888"),
      "http://drfed.localhost:8888",
    );
    assert.equal(parsed("http://example.com:80/"), "http://example.com");
  });

  it("returns a URL that is its own origin", () => {
    const result = parse("https://example.com/path");
    assert.ok(result.success);
    assert.equal(result.value.href, "https://example.com/");
    assert.equal(result.value.pathname, "/");
    assert.equal(result.value.search, "");
    assert.equal(result.value.username, "");
  });

  it("rejects input that is not an absolute URL", () => {
    for (const input of ["", "example.com", "/path", "https://"]) {
      assert.equal(parse(input).success, false, input);
    }
  });

  it("rejects protocols outside the allow list", () => {
    const options = { allowedProtocols: ["http:", "https:"] } as const;
    assert.equal(parsed("https://example.com", options), "https://example.com");
    assert.equal(parsed("http://example.com", options), "http://example.com");
    assert.equal(parse("ftp://example.com", options).success, false);
  });

  it("matches allowed protocols case-insensitively", () => {
    assert.equal(
      parsed("https://example.com", { allowedProtocols: ["HTTPS:"] }),
      "https://example.com",
    );
  });

  it("rejects URLs without a tuple origin", () => {
    for (const input of ["mailto:someone@example.com", "data:,hello"]) {
      assert.equal(parse(input).success, false, input);
    }
  });

  it("rejects a malformed allow list at construction time", () => {
    assert.throws(() => origin({ allowedProtocols: [] }), TypeError);
    // Missing the trailing colon would otherwise construct fine and then
    // reject every input, reporting the rejected protocol as an allowed one.
    assert.throws(() => origin({ allowedProtocols: ["https"] }), TypeError);
    assert.throws(
      () => origin({ allowedProtocols: ["https:", "ftp"] }),
      TypeError,
    );
  });

  it("round-trips through format() and normalize()", () => {
    const parser = origin();
    const result = parser.parse("https://example.com/path");
    assert.ok(result.success);
    assert.equal(parser.format(result.value), "https://example.com");
    const reparsed = parser.parse(parser.format(result.value));
    assert.ok(reparsed.success);
    assert.equal(reparsed.value.href, result.value.href);
    assert.equal(
      parser.normalize?.(new URL("https://example.com/path")).href,
      "https://example.com/",
    );
  });

  it("accepts IP literals by default", () => {
    assert.equal(parsed("http://127.0.0.1:8888"), "http://127.0.0.1:8888");
    assert.equal(parsed("http://[::1]:8888"), "http://[::1]:8888");
  });

  it("rejects IP literals when they cannot take a subdomain", () => {
    const options = { allowIpLiterals: false } as const;
    // `foo.127.0.0.1` and `foo.[::1]` are not host names; prefixing a label
    // to either of these makes a URL that does not parse at all.
    for (const input of [
      "http://127.0.0.1:8888",
      "http://[::1]:8888",
      "http://[2001:db8::1]",
      // The URL parser canonicalizes every other IPv4 spelling into the
      // dotted quad, so these are the same host as 127.0.0.1.
      "http://0x7f.1",
      "http://2130706433",
    ]) {
      assert.equal(parse(input, options).success, false, input);
    }
    assert.equal(parsed("https://drfed.net", options), "https://drfed.net");
    // A name that merely begins with digits is still a name.
    assert.equal(parsed("https://1.drfed.net", options), "https://1.drfed.net");
  });

  it("sees through a URL that hides its authority in its origin", () => {
    // A `blob:` URL reports an empty `hostname` while its origin carries the
    // authority embedded in it, so a check against the original URL would let
    // an IP address through.
    for (const input of [
      "blob:http://127.0.0.1:8888/id",
      "blob:http://[::1]/id",
    ]) {
      assert.equal(
        parse(input, { allowIpLiterals: false }).success,
        false,
        input,
      );
    }
    // Still accepted when IP literals are allowed, normalized to the origin.
    assert.equal(
      parsed("blob:http://127.0.0.1:8888/id"),
      "http://127.0.0.1:8888",
    );
  });

  it("offers a placeholder that is a valid origin", () => {
    assert.equal(origin().placeholder.origin, "http://0.invalid");
    assert.equal(
      origin({ allowedProtocols: ["https:"] }).placeholder.origin,
      "https://0.invalid",
    );
  });

  it("uses ORIGIN as the default metavar", () => {
    assert.equal(origin().metavar, "ORIGIN");
    assert.equal(origin({ metavar: "ROOT" }).metavar, "ROOT");
  });
});
