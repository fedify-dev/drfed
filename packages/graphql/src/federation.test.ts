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

import { createYogaServer } from "@drfed/graphql";
import createFederation, { buildFederation } from "@drfed/graphql/federation";
import { schema } from "@drfed/models";
import { uuidV7 } from "@drfed/models/uuid";
import { MemoryKvStore } from "@fedify/fedify";
import { describe, it } from "@logtape/testing-node/autoload";

import { withTemporaryDatabase, withTestHarness } from "./harness.test.ts";

const origin = new URL("https://drfed.test");
const activityJson = "application/activity+json";

describe("createFederation()", () => {
  it("registers the actor URI layout", async () => {
    await withTemporaryDatabase(async (db) => {
      const federation = await createFederation(db, {
        kv: new MemoryKvStore(),
      });
      const ctx = federation.createContext(origin, undefined);
      assert.equal(
        ctx.getActorUri("identifier").href,
        "https://drfed.test/users/identifier",
      );
      assert.equal(
        ctx.getInboxUri("identifier").href,
        "https://drfed.test/users/identifier/inbox",
      );
      assert.equal(ctx.getInboxUri().href, "https://drfed.test/inbox");
      assert.equal(
        ctx.getOutboxUri("identifier").href,
        "https://drfed.test/users/identifier/outbox",
      );
      assert.equal(
        ctx.getFollowersUri("identifier").href,
        "https://drfed.test/users/identifier/followers",
      );
      assert.equal(
        ctx.getFollowingUri("identifier").href,
        "https://drfed.test/users/identifier/following",
      );
      assert.equal(
        ctx.getFeaturedUri("identifier").href,
        "https://drfed.test/users/identifier/featured",
      );
    });
  });

  it("resolves an actor when the Host names the authority differently", async () => {
    // A reverse proxy may forward a `Host` that writes out the default port,
    // so `Context.host` reads `demo.drfed.test:443` while the stored host is
    // `demo.drfed.test`.  Without canonicalizing the lookup key, every actor
    // on that instance answers 404 to such a request.
    await withTemporaryDatabase(async (db) => {
      const localInstanceId = uuidV7();
      const instanceId = uuidV7();
      const localActorId = uuidV7();
      const actorId = uuidV7();
      const base = "https://demo.drfed.test";
      await db.insert(schema.localInstances).values({
        id: localInstanceId,
        slug: "demo",
        expires: new Date(Date.now() + 86_400_000),
      });
      await db.insert(schema.instances).values({
        id: instanceId,
        localId: localInstanceId,
        host: "demo.drfed.test",
      });
      await db.insert(schema.localActors).values({ id: localActorId });
      await db.insert(schema.actors).values({
        id: actorId,
        localId: localActorId,
        type: "Person",
        username: "alice",
        instanceId,
        iri: `${base}/users/${actorId}`,
        inboxUrl: `${base}/users/${actorId}/inbox`,
        outboxUrl: `${base}/users/${actorId}/outbox`,
      });

      const federation = await createFederation(db, {
        kv: new MemoryKvStore(),
      });
      const fetchAs = async (host: string): Promise<number> => {
        const response = await federation.fetch(
          // HTTP, so that `URL` keeps a port of 443 instead of eliding it.
          new Request(`http://${host}/users/${actorId}`, {
            headers: { accept: activityJson },
          }),
          {
            contextData: undefined,
            onNotFound: () => new Response(null, { status: 404 }),
            onNotAcceptable: () => new Response(null, { status: 406 }),
          },
        );
        return response.status;
      };

      assert.equal(await fetchAs("demo.drfed.test"), 200);
      assert.equal(await fetchAs("demo.drfed.test:443"), 200);
      // A genuinely different authority still resolves to nothing.
      assert.equal(await fetchAs("demo.drfed.test:9999"), 404);
      assert.equal(await fetchAs("other.drfed.test"), 404);

      // WebFinger resolves the handle through a second lookup of its own, so
      // it needs the same tolerance; without it, `acct:` on the port-carrying
      // spelling answers 404 while the actor dispatcher answers 200.
      const webFingerAs = async (host: string): Promise<number> => {
        const resource = encodeURIComponent(`acct:alice@${host}`);
        const response = await federation.fetch(
          new Request(
            `http://${host}/.well-known/webfinger?resource=${resource}`,
          ),
          {
            contextData: undefined,
            onNotFound: () => new Response(null, { status: 404 }),
            onNotAcceptable: () => new Response(null, { status: 406 }),
          },
        );
        return response.status;
      };
      assert.equal(await webFingerAs("demo.drfed.test"), 200);
      assert.equal(await webFingerAs("demo.drfed.test:443"), 200);
      assert.equal(await webFingerAs("demo.drfed.test:9999"), 404);
    });
  });

  it("builds independent instances from one builder", async () => {
    await withTemporaryDatabase(async (db) => {
      const builder = buildFederation(db);
      const first = await builder.build({ kv: new MemoryKvStore() });
      const second = await builder.build({ kv: new MemoryKvStore() });
      assert.notEqual(first, second);
    });
  });
});

describe("createYogaServer()", () => {
  it("does not mutate the federation instance", async () => {
    await withTestHarness(({ db, mailer, federation }) => {
      const loginOrigins = new Set(["https://drfed.test"]);
      assert.doesNotThrow(() =>
        createYogaServer(db, federation, {
          mailer,
          loginOrigins,
          rootOrigin: new URL("https://drfed.test"),
        }),
      );
    });
  });
});
