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
import { Object as ASObject } from "@fedify/vocab";
import { describe, it } from "@logtape/testing-node/autoload";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";

import { withTemporaryDatabase, withTestHarness } from "./harness.test.ts";
import {
  localActorId,
  remoteActorId,
  seedLocalActor,
  seedRemoteActor,
} from "./seed.test.ts";

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
        ctx.getObjectUri(ASObject, { identifier: "a", id: "b" }).href,
        "https://drfed.test/users/a/objects/b",
      );
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

const actorIri = `https://test-instance.drfed.org/users/${localActorId}`;
const accept = { accept: "application/activity+json" };

function values(id: string) {
  return {
    id,
    actorId: localActorId,
    iri: `${actorIri}/objects/${id}`,
    type: "Note" as const,
    contentHtml: "<p>Hello</p>",
  };
}

describe("ActivityPub objects", () => {
  for (const visibility of ["public", "unlisted"] as const) {
    it(`serves ${visibility} objects with contentMap and recipients`, async () => {
      await withTestHarness(async ({ db, federation }) => {
        await seedLocalActor(db);
        const object = values(uuid());
        await db.insert(schema.objects).values({
          ...object,
          visibility,
          language: "ko-KR",
          name: "Title",
          summary: "CW",
          sensitive: true,
        });
        const response = await federation.fetch(
          new Request(object.iri, { headers: accept }),
          { contextData: undefined },
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.type, "Note");
        assert.equal(body.id, object.iri);
        assert.equal(body.attributedTo, actorIri);
        assert.equal(body.content, object.contentHtml);
        assert.deepEqual(body.contentMap, { "ko-kr": object.contentHtml });
        assert.equal(body.name, "Title");
        assert.equal(body.summary, "CW");
        assert.equal(body.sensitive, true);
        assert.ok(body.published);
        assert.ok(body.updated);
        assert.equal(
          body.to,
          visibility === "public" ? "as:Public" : `${actorIri}/followers`,
        );
        assert.equal(
          body.cc,
          visibility === "public" ? `${actorIri}/followers` : "as:Public",
        );
      });
    });
  }
  for (const deleted of [null, new Date("2026-09-06T12:00:00Z")]) {
    it(`does not serve followers-only objects (deleted: ${deleted != null})`, async () => {
      await withTestHarness(async ({ db, federation }) => {
        await seedLocalActor(db);
        const object = values(uuid());
        await db
          .insert(schema.objects)
          .values({ ...object, visibility: "followers", deleted });
        const response = await federation.fetch(
          new Request(object.iri, { headers: accept }),
          { contextData: undefined },
        );
        assert.equal(response.status, 404);
      });
    });
  }
  it("serves Articles and tombstones", async () => {
    await withTestHarness(async ({ db, federation }) => {
      await seedLocalActor(db);
      const object = values(uuid());
      await db.insert(schema.objects).values({ ...object, type: "Article" });
      const response = await federation.fetch(
        new Request(object.iri, { headers: accept }),
        { contextData: undefined },
      );
      assert.equal((await response.json()).type, "Article");
      const deletedAt = new Date("2026-09-06T12:00:00.000Z");
      await db
        .update(schema.objects)
        .set({ deleted: deletedAt })
        .where(eq(schema.objects.id, object.id));
      const deleted = await federation.fetch(
        new Request(object.iri, { headers: accept }),
        { contextData: undefined },
      );
      // Fedify serializes generic object tombstones with HTTP 200.
      assert.equal(deleted.status, 200);
      const tombstone = await deleted.json();
      assert.equal(tombstone.type, "Tombstone");
      assert.equal(new Date(tombstone.deleted).getTime(), deletedAt.getTime());
    });
  });
  for (const scenario of [
    "missing",
    "malformed",
    "remote",
    "host",
    "actor",
    "deletedActor",
  ] as const) {
    it(`rejects ${scenario} object requests`, async () => {
      await withTestHarness(async ({ db, federation }) => {
        await seedLocalActor(db);
        await seedRemoteActor(db);
        const object = values(uuid());
        await db.insert(schema.objects).values({
          ...object,
          actorId: scenario === "remote" ? remoteActorId : localActorId,
        });
        if (scenario === "deletedActor") {
          await db
            .update(schema.actors)
            .set({ deleted: new Date() })
            .where(eq(schema.actors.id, localActorId));
        }
        const iri =
          scenario === "missing"
            ? `${actorIri}/objects/${uuid()}`
            : scenario === "malformed"
              ? `${actorIri}/objects/bad`
              : scenario === "host"
                ? object.iri.replace("test-instance.drfed.org", "wrong.example")
                : scenario === "actor" || scenario === "remote"
                  ? object.iri.replace(localActorId, remoteActorId)
                  : object.iri;
        const response = await federation.fetch(
          new Request(iri, { headers: accept }),
          { contextData: undefined },
        );
        assert.equal(response.status, 404);
      });
    });
  }
});

describe("ActivityPub outbox", () => {
  it("paginates Create activities while excluding followers-only and deleted objects", async () => {
    await withTestHarness(async ({ db, federation }) => {
      await seedLocalActor(db);
      const ids = Array.from({ length: 23 }, () => uuid());
      await db.insert(schema.objects).values(
        ids.map((id, index) => ({
          ...values(id),
          visibility:
            index === 22
              ? ("followers" as const)
              : index === 20
                ? ("unlisted" as const)
                : ("public" as const),
          deleted: index === 21 ? new Date() : null,
        })),
      );
      await db
        .update(schema.actors)
        .set({ postsCount: 23 })
        .where(eq(schema.actors.id, localActorId));
      const fetchJson = async (iri: string) => {
        const response = await federation.fetch(
          new Request(iri, { headers: accept }),
          { contextData: undefined },
        );
        assert.equal(response.status, 200);
        return await response.json();
      };
      const collection = await fetchJson(`${actorIri}/outbox`);
      assert.equal(collection.type, "OrderedCollection");
      assert.equal(collection.totalItems, 23);
      const page = await fetchJson(`${actorIri}/outbox?cursor=`);
      assert.equal(page.orderedItems.length, 20);
      const activity = page.orderedItems[0];
      assert.deepEqual(
        {
          type: activity.type,
          id: activity.id,
          actor: activity.actor,
          objectId: activity.object.id,
          to: activity.to,
          cc: activity.cc,
        },
        {
          type: "Create",
          id: `${values(ids[20]!).iri}/activity`,
          actor: actorIri,
          objectId: values(ids[20]!).iri,
          to: `${actorIri}/followers`,
          cc: "as:Public",
        },
      );
      const last = await fetchJson(page.next);
      assert.equal(last.orderedItems.length, 1);
      assert.equal(last.orderedItems[0].object.id, values(ids[0]!).iri);
      assert.equal(last.next, undefined);
      const bad = await federation.fetch(
        new Request(`${actorIri}/outbox?cursor=bad`, { headers: accept }),
        { contextData: undefined },
      );
      assert.equal(bad.status, 404);
    });
  });
  it("serves an empty outbox", async () => {
    await withTestHarness(async ({ db, federation }) => {
      await seedLocalActor(db);
      const response = await federation.fetch(
        new Request(`${actorIri}/outbox?cursor=`, { headers: accept }),
        { contextData: undefined },
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.type, "OrderedCollectionPage");
      assert.deepEqual(body.orderedItems ?? [], []);
      assert.equal(body.next, undefined);
    });
  });
});
