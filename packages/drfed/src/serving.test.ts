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
  createFetchHandler,
  findStrandedInstances,
  warnAboutStrandedInstances,
} from "@drfed/drfed/serving";
import { migrate, relations, schema } from "@drfed/models";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { describe, it } from "@logtape/testing-node/autoload";
import { drizzle } from "drizzle-orm/pglite";

const rootOrigin = new URL("https://drfed.net");
const dayInMilliseconds = 86_400_000;

/**
 * A stand-in for the request object a server adapter hands the handler, whose
 * `url` may be a string `URL` refuses.  `Request` cannot express that: undici
 * parses the URL in its own constructor.
 * @param url The request URL, valid or not.
 * @param host The `Host` header to report.
 * @returns Something shaped enough like a `Request` for the router.
 */
function fakeRequest(url: string, host: string): Request {
  return { headers: new Headers({ host }), url } as Request;
}

function handler(): {
  handle: (request: Request) => Promise<Response>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  federationCalls: string[];
  controlCalls: string[];
} {
  const federationCalls: string[] = [];
  const controlCalls: string[] = [];
  const handle = createFetchHandler({
    rootOrigin,
    federation: {
      async fetch(request, options) {
        federationCalls.push(request.url);
        // Stand in for a dispatcher that resolved to nothing, which is what
        // every route does on a subdomain no instance has claimed.
        return await options.onNotFound(request);
      },
    },
    serveControlSurface(request) {
      controlCalls.push(request.url);
      return new Response("graphql", { status: 200 });
    },
  });
  return {
    handle,
    fetch: async (url, init) => await handle(new Request(url, init)),
    federationCalls,
    controlCalls,
  };
}

describe("createFetchHandler()", () => {
  it("serves ActivityPub on an instance subdomain", async () => {
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("https://foo-bar.drfed.net/users/x");
    assert.equal(response.status, 404);
    assert.deepEqual(federationCalls, ["https://foo-bar.drfed.net/users/x"]);
    assert.deepEqual(controlCalls, []);
  });

  it("keeps the control surface off instance subdomains", async () => {
    // The whole point of routing by authority: a tenant's host must never
    // answer for GraphQL, even though the same process serves it.
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("https://foo-bar.drfed.net/graphql");
    assert.equal(response.status, 404);
    assert.deepEqual(controlCalls, []);
    assert.equal(federationCalls.length, 1);
  });

  it("serves the control surface on the root origin", async () => {
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("https://drfed.net/graphql");
    assert.equal(response.status, 200);
    assert.deepEqual(controlCalls, ["https://drfed.net/graphql"]);
    assert.deepEqual(federationCalls, []);
  });

  it("serves the control surface on an unrelated authority", async () => {
    // The frontend reaches the backend by its listening address, which names
    // no instance; that has to keep working.
    const { fetch, controlCalls } = handler();
    assert.equal((await fetch("http://127.0.0.1:8888/graphql")).status, 200);
    assert.equal((await fetch("http://localhost:3000/graphql")).status, 200);
    assert.equal(controlCalls.length, 2);
  });

  it("answers 421 below an instance subdomain", async () => {
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("https://a.b.drfed.net/");
    assert.equal(response.status, 421);
    assert.deepEqual(federationCalls, []);
    assert.deepEqual(controlCalls, []);
  });

  it("refuses a request whose URL disagrees with its Host header", async () => {
    // The srvx adapter substitutes the literal `_invalid_` for a `Host` it
    // cannot parse, which would otherwise classify as the control surface and
    // answer GraphQL to a request that named a tenant.
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("http://_invalid_/graphql", {
      headers: { host: "foo-bar.drfed.net." },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(controlCalls, []);
    assert.deepEqual(federationCalls, []);
  });

  it("refuses a request URL that cannot be parsed", async () => {
    // The srvx adapter validates `Host` against a structural pattern and
    // builds the request URL by concatenation, so hosts that `URL` rejects
    // still reach the handler.  Parsing one used to throw, and with no rejection handler
    // anywhere above, a single unauthenticated request ended the process.
    const { handle, federationCalls, controlCalls } = handler();
    // Both fail the WHATWG IPv4 host parser, which is spec-defined rather
    // than a property of whichever ICU the runtime was built with.
    const hosts = ["1.2.3.4.5", "999.1.1.1"];
    const results = await Promise.all(
      hosts.map(async (host) => {
        assert.equal(URL.canParse(`http://${host}/`), false, host);
        const response = await handle(fakeRequest(`http://${host}/`, host));
        return { host, status: response.status };
      }),
    );
    for (const { host, status } of results) {
      assert.equal(status, 400, host);
    }
    assert.deepEqual(controlCalls, []);
    assert.deepEqual(federationCalls, []);
  });

  it("accepts a Host that merely spells the authority differently", async () => {
    // A reverse proxy may forward a `Host` that writes out the default port,
    // and the check must not fire on that.
    const { fetch } = handler();
    const control = await fetch("https://drfed.net/graphql", {
      headers: { host: "drfed.net:443" },
    });
    assert.equal(control.status, 200);
    // A root-zone dot is likewise only a spelling, and the check tolerates it
    // here.  Note this shape does not actually reach the handler in
    // production: srvx's own host pattern rejects a trailing dot and
    // substitutes `_invalid_`, so such a request is answered 400 above.  The
    // tolerance still matters for adapters that do pass it through.
    const tenant = await fetch("https://foo-bar.drfed.net/users/x", {
      headers: { host: "foo-bar.drfed.net." },
    });
    assert.equal(tenant.status, 404);
  });

  it("never asks the database what exists", async () => {
    // An unclaimed subdomain still routes to ActivityPub, where the
    // dispatchers resolve to nothing.  That is what keeps routing free of a
    // per-request lookup.
    const { fetch, federationCalls } = handler();
    assert.equal((await fetch("https://nobody.drfed.net/users/x")).status, 404);
    assert.deepEqual(federationCalls, ["https://nobody.drfed.net/users/x"]);
  });
});

describe("findStrandedInstances()", () => {
  it("reports only local instances outside the root origin", async () => {
    const client = new PGlite();
    try {
      await migrate({ credentials: { driver: "pglite", client } });
      const db = drizzle({ client, relations, schema });
      const rows = [
        // Reachable under the configured root origin.
        { host: "here.drfed.net", slug: "here", local: true },
        // Left behind by a root origin change.
        { host: "there.drfed.org", slug: "there", local: true },
        // Also stranded: an instance occupies exactly one label.
        { host: "deep.nested.drfed.net", slug: "deep", local: true },
        // Remote instances are nobody's business here.
        { host: "remote.example.com", slug: "remote", local: false },
        // Not a URL at all: the WHATWG IPv4 parser rejects it.  Reporting
        // such a row must not throw, because startup waits on this scan and
        // one bad row would otherwise keep the deployment from coming back
        // up.  The slug and the host disagree here, which is the point: only
        // the stored host is consulted.
        { host: "999.1.1.1", slug: "unparseable", local: true },
      ];
      const expires = new Date(Date.now() + dayInMilliseconds);
      const seeded = rows.map(({ host, slug, local }) => ({
        host,
        localId: local ? uuidV7() : null,
        slug,
      }));
      await db
        .insert(schema.localInstances)
        .values(
          seeded
            .filter(({ localId }) => localId != null)
            .map(({ localId, slug }) => ({ id: localId!, slug, expires })),
        );
      await db
        .insert(schema.instances)
        .values(
          seeded.map(({ host, localId }) => ({ id: uuidV7(), localId, host })),
        );

      const stranded = await findStrandedInstances(db, rootOrigin);
      assert.deepEqual([...stranded].sort(), [
        "999.1.1.1",
        "deep.nested.drfed.net",
        "there.drfed.org",
      ]);
      assert.ok(!stranded.includes("here.drfed.net"));
      // It only reports; nothing is rewritten.
      const after = await db.select().from(schema.instances);
      assert.deepEqual(
        after.map(({ host }) => host).sort(),
        rows.map(({ host }) => host).sort(),
      );
      await warnAboutStrandedInstances(db, rootOrigin);
    } finally {
      await client.close();
    }
  });
});
