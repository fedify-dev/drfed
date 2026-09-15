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

import {
  classifyHost,
  instanceHost,
  instanceOrigin,
} from "@drfed/graphql/origin";
import { describe, it } from "@logtape/testing-node/autoload";

const production = new URL("https://drfed.net");
const development = new URL("http://drfed.localhost:8888");

describe("instanceHost()", () => {
  it("prefixes the slug to the root authority", () => {
    assert.equal(instanceHost(production, "foo-bar"), "foo-bar.drfed.net");
  });

  it("carries a non-default port into the instance authority", () => {
    assert.equal(
      instanceHost(development, "foo-bar"),
      "foo-bar.drfed.localhost:8888",
    );
  });

  it("drops a port that is the scheme's default", () => {
    assert.equal(
      instanceHost(new URL("https://drfed.net:443"), "foo-bar"),
      "foo-bar.drfed.net",
    );
  });

  it("drops the root zone's trailing dot", () => {
    assert.equal(
      instanceHost(new URL("https://drfed.net."), "foo-bar"),
      "foo-bar.drfed.net",
    );
    assert.equal(
      instanceHost(new URL("http://drfed.localhost.:8888"), "foo-bar"),
      "foo-bar.drfed.localhost:8888",
    );
  });
});

describe("instanceOrigin()", () => {
  it("keeps the root origin's scheme", () => {
    assert.equal(
      instanceOrigin(production, "foo-bar").origin,
      "https://foo-bar.drfed.net",
    );
    assert.equal(
      instanceOrigin(development, "foo-bar").origin,
      "http://foo-bar.drfed.localhost:8888",
    );
  });

  it("agrees with instanceHost()", () => {
    for (const root of [production, development]) {
      assert.equal(
        instanceOrigin(root, "foo-bar").host,
        instanceHost(root, "foo-bar"),
      );
    }
  });
});

describe("classifyHost()", () => {
  function classify(requestUrl: string, root: URL = production) {
    return classifyHost(new URL(requestUrl), root);
  }

  it("treats one label below the root domain as an instance", () => {
    assert.equal(classify("https://foo-bar.drfed.net/users/x"), "instance");
    assert.equal(classify("https://qux.drfed.net/"), "instance");
    assert.equal(
      classify("http://foo-bar.drfed.localhost:8888/inbox", development),
      "instance",
    );
  });

  it("treats the root origin itself as the control surface", () => {
    assert.equal(classify("https://drfed.net/graphql"), "admin");
    assert.equal(
      classify("http://drfed.localhost:8888/graphql", development),
      "admin",
    );
  });

  it("treats unrelated authorities as the control surface", () => {
    assert.equal(classify("http://127.0.0.1:8888/graphql"), "admin");
    assert.equal(classify("http://localhost:3000/graphql"), "admin");
    assert.equal(classify("https://internal.example.com/graphql"), "admin");
    // A host name that merely ends in the same characters is not a subdomain.
    assert.equal(classify("https://xdrfed.net/graphql"), "admin");
  });

  it("treats a deeper subdomain as misdirected", () => {
    assert.equal(classify("https://a.b.drfed.net/"), "misdirected");
    assert.equal(classify("https://a.b.c.drfed.net/"), "misdirected");
    assert.equal(
      classify("http://a.b.drfed.localhost:8888/", development),
      "misdirected",
    );
  });

  it("ignores the request scheme", () => {
    // A TLS-terminating reverse proxy forwards plain HTTP even when the
    // deployment's root origin is HTTPS.
    assert.equal(classify("http://foo-bar.drfed.net/users/x"), "instance");
    assert.equal(classify("http://drfed.net/graphql"), "admin");
  });

  it("reads either of the web's default ports as no port", () => {
    // A client may address the https default port explicitly, and a proxy may
    // forward that `Host` verbatim over plain HTTP, in which case `URL.port`
    // keeps the 443 that https would have elided.  It still names the same
    // authority, so it must not fall through to the control surface.
    assert.equal(classify("http://foo-bar.drfed.net:443/users/x"), "instance");
    assert.equal(classify("http://a.b.drfed.net:443/"), "misdirected");
    assert.equal(classify("http://drfed.net:443/graphql"), "admin");
    assert.equal(classify("https://foo-bar.drfed.net:80/users/x"), "instance");
    assert.equal(classify("https://foo-bar.drfed.net:443/users/x"), "instance");
    // Any other port still names a different authority.
    assert.equal(classify("http://foo-bar.drfed.net:8443/"), "admin");
  });

  it("treats an empty leading label as misdirected", () => {
    // The WHATWG parser accepts empty labels, so `Host: .drfed.net` is
    // reachable; it is a subdomain of nothing and can never name an instance.
    assert.equal(classify("https://.drfed.net/"), "misdirected");
    assert.equal(classify("https://foo..drfed.net/"), "misdirected");
  });

  it("distinguishes the port", () => {
    // The port is part of the authority instances federate under, so the same
    // host name on another port has not named an instance.
    assert.equal(classify("https://foo-bar.drfed.net:8443/"), "admin");
    assert.equal(
      classify("http://foo-bar.drfed.localhost:9999/", development),
      "admin",
    );
    assert.equal(
      classify("http://foo-bar.drfed.localhost/", development),
      "admin",
    );
  });

  it("ignores the root zone's trailing dot on either side", () => {
    // `foo-bar.drfed.net.` and `foo-bar.drfed.net` name the same host, so
    // neither may fall through to the control surface.
    assert.equal(classify("https://foo-bar.drfed.net./users/x"), "instance");
    assert.equal(classify("https://a.b.drfed.net./"), "misdirected");
    assert.equal(classify("https://drfed.net./graphql"), "admin");
    const dotted = new URL("https://drfed.net.");
    assert.equal(
      classify("https://foo-bar.drfed.net/users/x", dotted),
      "instance",
    );
    assert.equal(
      classify("https://foo-bar.drfed.net./users/x", dotted),
      "instance",
    );
    assert.equal(classify("https://a.b.drfed.net/", dotted), "misdirected");
    assert.equal(classify("https://drfed.net/graphql", dotted), "admin");
    const dottedDev = new URL("http://drfed.localhost.:8888");
    assert.equal(
      classify("http://foo-bar.drfed.localhost:8888/inbox", dottedDev),
      "instance",
    );
    assert.equal(
      classify("http://foo-bar.drfed.localhost.:8888/inbox", development),
      "instance",
    );
    assert.equal(
      classify("http://foo-bar.drfed.localhost.:9999/inbox", development),
      "admin",
    );
  });

  it("handles IPv6 literal authorities", () => {
    const loopback = new URL("http://[::1]:8888");
    assert.equal(classify("http://[::1]:8888/graphql", loopback), "admin");
    assert.equal(classify("http://[2001:db8::1]/graphql", loopback), "admin");
    assert.equal(classify("http://[::1]:9999/graphql", loopback), "admin");
  });

  it("round-trips a composed instance authority", () => {
    for (const root of [
      production,
      development,
      new URL("https://drfed.net."),
      new URL("http://drfed.localhost.:8888"),
    ]) {
      const url = instanceOrigin(root, "foo-bar");
      assert.equal(classifyHost(url, root), "instance");
    }
  });
});
