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

// Keep dependent database writes and observations sequential.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";

import createFederation, {
  buildFederation,
  enqueueActorKeyGeneration,
} from "@drfed/federation";
import { ensureActorKeyPairs } from "@drfed/federation/actor-key";
import { KeyGenerationQueue } from "@drfed/federation/task-queue";
import { schema } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import { type Uuid, uuidV7 as uuid } from "@drfed/models/uuid";
import {
  MemoryKvStore,
  exportJwk,
  generateCryptoKeyPair,
} from "@fedify/fedify";
import { Object as APObject, Create } from "@fedify/vocab";
import { describe, it } from "@logtape/testing-node/autoload";
import { eq, sql } from "drizzle-orm";

import { withFederation, withTemporaryDatabase } from "./harness.test.ts";
import {
  localActorId,
  remoteActorId,
  seedActorKeys,
  seedActors,
  seedLocalActor,
  seedObjects,
  seedRemoteActor,
} from "./seed.test.ts";

const actorIri = `https://test-instance.drfed.org/users/${localActorId}`;
const createIri = (id: string) =>
  `https://test-instance.drfed.org/ap/creates/${id}`;
const accept = { accept: "application/activity+json" };

function values(id: string) {
  return {
    id: id as Uuid,
    activityId: uuid(),
    actorId: localActorId as Uuid,
    iri: `${actorIri}/${id}`,
    type: "Note" as const,
    contentHtml: "<p>Hello</p>",
  };
}

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
        ctx.getObjectUri(APObject, { identifier: "a", id: "b" }).href,
        "https://drfed.test/users/a/b",
      );
      assert.equal(
        ctx.getObjectUri(Create, { id: "b" }).href,
        "https://drfed.test/ap/creates/b",
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
      const localInstanceId = uuid();
      const instanceId = uuid();
      const localId = uuid();
      const actorId = uuid();
      const base = "https://demo.drfed.test";
      await db.insert(schema.localInstances).values({
        id: localInstanceId,
        slug: "demo",
        expires: Temporal.Now.instant().add({ hours: 24 }),
      });
      await db.insert(schema.instances).values({
        id: instanceId,
        localId: localInstanceId,
        host: "demo.drfed.test",
      });
      await db.insert(schema.localActors).values({ id: localId });
      await seedActors(db, {
        id: actorId,
        localId,
        type: "Person",
        username: "alice",
        instanceId,
        iri: `${base}/users/${actorId}`,
        inboxUrl: `${base}/users/${actorId}/inbox`,
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

  it("keeps the database of each federation it builds", async () => {
    // Two databases hold an actor under the same identifier and host, so only
    // the database each federation was built from tells their answers apart.
    // Both federations are built before either serves a request, which is
    // what a builder shared across calls would get wrong.
    await withTemporaryDatabase(async (first) => {
      await withTemporaryDatabase(async (second) => {
        for (const [db, name] of [
          [first, "First"],
          [second, "Second"],
        ] as const) {
          await seedLocalActor(db);
          await db
            .update(schema.actors)
            .set({ name })
            .where(eq(schema.actors.id, localActorId));
        }
        const federations = [
          await createFederation(first, { kv: new MemoryKvStore() }),
          await createFederation(second, { kv: new MemoryKvStore() }),
        ];
        const names = [];
        for (const federation of federations) {
          const response = await federation.fetch(
            new Request(actorIri, { headers: accept }),
            { contextData: undefined },
          );
          assert.equal(response.status, 200);
          names.push((await response.json()).name);
        }
        assert.deepEqual(names, ["First", "Second"]);
      });
    });
  });
});

describe("ActivityPub resource origin spelling", () => {
  for (const resource of ["object", "Create", "Tombstone"] as const) {
    for (const requestOrigin of [
      "https://test-instance.drfed.org.",
      "http://test-instance.drfed.org",
    ]) {
      it(`serves ${resource} from ${requestOrigin} with its stored canonical IRI`, async () => {
        await withFederation(async ({ db, federation }) => {
          await seedLocalActor(db);
          const object = values(uuid());
          const deleted =
            resource === "Tombstone"
              ? Temporal.Instant.from("2026-09-06T12:00:00Z")
              : null;
          await seedObjects(db, { ...object, deleted });
          const iri =
            resource === "Create" ? createIri(object.activityId) : object.iri;
          const requestIri = new URL(new URL(iri).pathname, requestOrigin);
          const response = await federation.fetch(
            new Request(requestIri, { headers: accept }),
            { contextData: undefined },
          );
          assert.equal(response.status, resource === "Tombstone" ? 410 : 200);
          const body = await response.json();
          assert.equal(body.id, iri);
          assert.equal(body.type, resource === "object" ? "Note" : resource);
          if (deleted != null) {
            assert.equal(
              Temporal.Instant.from(body.deleted).epochNanoseconds,
              deleted.epochNanoseconds,
            );
          }
        });
      });
    }
  }
});

describe("ActivityPub objects", () => {
  for (const publicProperty of ["to", "cc"] as const) {
    it(`serves ${publicProperty} Public objects with contentMap and recipients`, async () => {
      await withFederation(async ({ db, federation }) => {
        await seedLocalActor(db);
        const object = values(uuid());
        await seedObjects(db, {
          ...object,
          addressing: {
            [publicProperty]: [PUBLIC_IRI],
            [publicProperty === "to" ? "cc" : "to"]: [`${actorIri}/followers`],
          },
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
          publicProperty === "to" ? "as:Public" : `${actorIri}/followers`,
        );
        assert.equal(
          body.cc,
          publicProperty === "to" ? `${actorIri}/followers` : "as:Public",
        );
      });
    });
  }
  for (const deleted of [null, Temporal.Instant.from("2026-09-06T12:00:00Z")]) {
    it(`does not serve followers-only objects (deleted: ${deleted != null})`, async () => {
      await withFederation(async ({ db, federation }) => {
        await seedLocalActor(db);
        const object = values(uuid());
        await seedObjects(db, {
          ...object,
          addressing: {
            to: [
              `https://test-instance.drfed.org/users/${localActorId}/followers`,
            ],
          },
          deleted,
        });
        const response = await federation.fetch(
          new Request(object.iri, { headers: accept }),
          { contextData: undefined },
        );
        assert.equal(response.status, 404);
      });
    });
  }
  it("serves Articles and tombstones", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db);
      const object = values(uuid());
      await seedObjects(db, { ...object, type: "Article" });
      const response = await federation.fetch(
        new Request(object.iri, { headers: accept }),
        { contextData: undefined },
      );
      assert.equal((await response.json()).type, "Article");
      const deletedAt = Temporal.Instant.from("2026-09-06T12:00:00.000Z");
      await db
        .update(schema.objects)
        .set({ deleted: deletedAt })
        .where(eq(schema.objects.id, object.id));
      const deleted = await federation.fetch(
        new Request(object.iri, { headers: accept }),
        { contextData: undefined },
      );
      // Fedify serves object tombstones with HTTP 410, keeping the body.
      assert.equal(deleted.status, 410);
      const tombstone = await deleted.json();
      assert.equal(tombstone.type, "Tombstone");
      assert.equal(
        Temporal.Instant.from(tombstone.deleted).epochNanoseconds,
        deletedAt.epochNanoseconds,
      );
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
      await withFederation(async ({ db, federation }) => {
        await seedLocalActor(db);
        await seedRemoteActor(db);
        const object = values(uuid());
        await seedObjects(db, {
          ...object,
          actorId: scenario === "remote" ? remoteActorId : localActorId,
        });
        if (scenario === "deletedActor") {
          await db
            .update(schema.actors)
            .set({ deleted: Temporal.Now.instant() })
            .where(eq(schema.actors.id, localActorId));
        }
        const iri =
          scenario === "missing"
            ? `${actorIri}/${uuid()}`
            : scenario === "malformed"
              ? `${actorIri}/bad`
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

describe("ActivityPub Create activities", () => {
  for (const publicProperty of ["to", "cc"] as const) {
    it(`serves Create activities for ${publicProperty} Public objects`, async () => {
      await withFederation(async ({ db, federation }) => {
        await seedLocalActor(db);
        const object = values(uuid());
        await seedObjects(db, {
          ...object,
          addressing: {
            [publicProperty]: [PUBLIC_IRI],
            [publicProperty === "to" ? "cc" : "to"]: [`${actorIri}/followers`],
          },
        });
        const response = await federation.fetch(
          new Request(createIri(object.activityId), { headers: accept }),
          { contextData: undefined },
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.deepEqual(
          {
            type: body.type,
            id: body.id,
            actor: body.actor,
            object: body.object,
            to: body.to,
            cc: body.cc,
          },
          {
            type: "Create",
            id: createIri(object.activityId),
            actor: actorIri,
            object: object.iri,
            to: publicProperty === "to" ? "as:Public" : `${actorIri}/followers`,
            cc: publicProperty === "to" ? `${actorIri}/followers` : "as:Public",
          },
        );
        assert.ok(body.published);
      });
    });
  }
  for (const scenario of [
    "followers",
    "deleted",
    "missing",
    "malformed",
    "remote",
    "deletedActor",
  ] as const) {
    it(`rejects ${scenario} Create requests`, async () => {
      await withFederation(async ({ db, federation }) => {
        await seedLocalActor(db);
        await seedRemoteActor(db);
        const object = values(uuid());
        await seedObjects(db, {
          ...object,
          actorId: scenario === "remote" ? remoteActorId : localActorId,
          addressing:
            scenario === "followers"
              ? { to: [`${actorIri}/followers`] }
              : { to: [PUBLIC_IRI] },
          deleted: scenario === "deleted" ? Temporal.Now.instant() : null,
        });
        if (scenario === "deletedActor") {
          await db
            .update(schema.actors)
            .set({ deleted: Temporal.Now.instant() })
            .where(eq(schema.actors.id, localActorId));
        }
        const iri =
          scenario === "missing"
            ? createIri(uuid())
            : scenario === "malformed"
              ? createIri("bad")
              : createIri(object.activityId);
        const response = await federation.fetch(
          new Request(iri, { headers: accept }),
          { contextData: undefined },
        );
        assert.equal(response.status, 404);
      });
    });
  }
  it("rejects Create requests from another host", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db);
      const object = values(uuid());
      await seedObjects(db, object);
      const response = await federation.fetch(
        new Request(
          createIri(object.activityId).replace(
            "test-instance.drfed.org",
            "wrong.example",
          ),
          { headers: accept },
        ),
        { contextData: undefined },
      );
      assert.equal(response.status, 404);
    });
  });
});

describe("ActivityPub outbox", () => {
  it("paginates Create activities while excluding followers-only and deleted objects", async () => {
    // oxlint-disable-next-line max-statements
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db);
      const ids = Array.from({ length: 23 }, () => uuid());
      const activityIds = ids.map(() => uuid());
      await seedObjects(
        db,
        ids.map((id, index) => ({
          ...values(id),
          activityId: activityIds[index]!,
          addressing:
            index === 22
              ? { to: [`${actorIri}/followers`] }
              : index === 20
                ? { to: [`${actorIri}/followers`], cc: [PUBLIC_IRI] }
                : { to: [PUBLIC_IRI] },
          deleted: index === 21 ? Temporal.Now.instant() : null,
        })),
      );
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
      assert.equal(collection.totalItems, 21);
      const page = await fetchJson(`${actorIri}/outbox?cursor=`);
      assert.equal(page.orderedItems.length, 20);
      const activity = page.orderedItems[0];
      assert.deepEqual(
        {
          type: activity.type,
          id: activity.id,
          actor: activity.actor,
          object: activity.object,
          to: activity.to,
          cc: activity.cc,
        },
        {
          type: "Create",
          id: createIri(activityIds[20]!),
          actor: actorIri,
          object: values(ids[20]!).iri,
          to: `${actorIri}/followers`,
          cc: "as:Public",
        },
      );
      const last = await fetchJson(page.next);
      assert.equal(last.orderedItems.length, 1);
      assert.equal(last.orderedItems[0].object, values(ids[0]!).iri);
      assert.equal(last.next, undefined);
      const bad = await federation.fetch(
        new Request(`${actorIri}/outbox?cursor=bad`, { headers: accept }),
        { contextData: undefined },
      );
      assert.equal(bad.status, 404);
      for (const published of [
        "0000-01-01T00:00:00.000000Z",
        "2026-02-30T00:00:00.000000Z",
      ]) {
        const cursor = encodeURIComponent(`${published}|${uuid()}`);
        const invalid = await federation.fetch(
          new Request(`${actorIri}/outbox?cursor=${cursor}`, {
            headers: accept,
          }),
          { contextData: undefined },
        );
        assert.equal(invalid.status, 404);
      }
    });
  });
  it("orders UUIDv4 backfills by publication and retains microseconds across pages", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db);
      const objects = Array.from({ length: 24 }, () => uuid());
      for (const [index, id] of objects.entries()) {
        // Old migrated activities have random UUIDv4 IDs larger than UUIDv7.
        // Reverse IDs deliberately oppose publication order within a page.
        const activityId =
          index === 23
            ? uuid()
            : (`ffffffff-ffff-4fff-8fff-${String(24 - index).padStart(12, "0")}` as Uuid);
        await seedObjects(db, { ...values(id), activityId });
        const published = `2026-09-15T00:00:00.${String(Math.floor(index / 2)).padStart(6, "0")}Z`;
        await db
          .update(schema.activities)
          .set({ published: sql`${published}::timestamptz` })
          .where(eq(schema.activities.id, activityId));
      }
      const fetchJson = async (iri: string) => {
        const response = await federation.fetch(
          new Request(iri, { headers: accept }),
          { contextData: undefined },
        );
        assert.equal(response.status, 200);
        return await response.json();
      };
      const first = await fetchJson(`${actorIri}/outbox?cursor=`);
      assert.equal(first.orderedItems.length, 20);
      // Equal publication times use descending IDs as a stable tie-breaker.
      const expected = Array.from({ length: 12 }, (_, index) => 22 - 2 * index)
        .flatMap((index) => [objects[index], objects[index + 1]])
        .map((id) => values(id!).iri);
      assert.deepEqual(
        first.orderedItems.map((item: { object: string }) => item.object),
        expected.slice(0, 20),
      );
      // A cursor remains valid even if its activity has since been deleted.
      const boundary = new URL(first.next).searchParams
        .get("cursor")!
        .split("|")[1]!;
      await db
        .delete(schema.resources)
        .where(eq(schema.resources.id, boundary as Uuid));
      const last = await fetchJson(first.next);
      assert.deepEqual(
        last.orderedItems.map((item: { object: string }) => item.object),
        expected.slice(20),
      );
      assert.equal(last.next, undefined);
    });
  });
  it("serves an empty outbox", async () => {
    await withFederation(async ({ db, federation }) => {
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

describe("stored collection membership and independent activity addressing", () => {
  it("serves stored Create IRIs and uses activity addressing for outbox and Create", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db);
      const object = values(uuid());
      await seedObjects(db, object);
      const activity = await db.query.activities.findFirst({
        where: { objectId: object.id },
        with: { resource: true },
      });
      assert.ok(activity);
      assert.notEqual(activity.id, object.id);
      assert.equal(activity.resource.iri, createIri(activity.id));
      const fetch = (iri: string) =>
        federation.fetch(new Request(iri, { headers: accept }), {
          contextData: undefined,
        });
      assert.equal((await fetch(createIri(object.activityId))).status, 200);
      await db
        .delete(schema.addressing)
        .where(eq(schema.addressing.sourceId, activity.id));
      assert.equal((await fetch(createIri(object.activityId))).status, 404);
      assert.equal((await fetch(object.iri)).status, 200);
      assert.equal(
        (await (await fetch(`${actorIri}/outbox`)).json()).totalItems,
        0,
      );
      assert.deepEqual(
        (await (await fetch(`${actorIri}/outbox?cursor=`)).json())
          .orderedItems ?? [],
        [],
      );
      const rows = await db.query.addressing.findMany({
        where: { sourceId: object.id },
      });
      assert.ok(rows.length > 0);
    });
  });
  it("reads collection_items for followers, following and featured", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db);
      await seedRemoteActor(db);
      const fetch = (iri: string) =>
        federation.fetch(new Request(iri, { headers: accept }), {
          contextData: undefined,
        });
      for (const role of ["followers", "following", "featured"] as const) {
        const reference = await db.query.actorCollectionReferences.findFirst({
          where: { actorId: localActorId, role },
          with: { collection: true },
        });
        assert.ok(reference);
        const { collection } = reference;
        await db.insert(schema.collectionItems).values({
          collectionId: collection.id,
          itemId: remoteActorId,
          position: 0,
        });
        const response = await fetch(`${actorIri}/${role}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        const item = body.orderedItems?.[0] ?? body.items?.[0];
        assert.equal(
          typeof item === "string" ? item : item?.id,
          "https://remote.example.com/users/bob",
        );
      }
    });
  });
});

describe("durable actor signing keys", () => {
  it("generates keys on first use and publishes only their public forms", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db, { keys: false });
      assert.equal(await db.$count(schema.localActorKeys), 0);
      const response = await federation.fetch(
        new Request(actorIri, { headers: accept }),
        { contextData: undefined },
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.publicKey.id, `${actorIri}#main-key`);
      assert.equal(body.assertionMethod.length, 2);
      assert.ok(body.publicKey.publicKeyPem);
      const ctx = federation.createContext(new URL(actorIri), undefined);
      const first = await ctx.getActorKeyPairs(localActorId);
      assert.deepEqual(
        first.map((pair) => pair.privateKey.algorithm.name),
        ["RSASSA-PKCS1-v1_5", "Ed25519"],
      );
      const saved = await db.select().from(schema.localActorKeys);
      assert.equal(saved.length, 2);
      assert.equal(
        JSON.stringify(body).includes(saved[0]!.privateKey["d"]!),
        false,
      );
      const fresh = await createFederation(db, { kv: new MemoryKvStore() });
      const again = await fresh
        .createContext(new URL(actorIri), undefined)
        .getActorKeyPairs(localActorId);
      assert.deepEqual(
        await crypto.subtle.exportKey("jwk", first[0]!.publicKey),
        await crypto.subtle.exportKey("jwk", again[0]!.publicKey),
      );
      assert.deepEqual(await db.select().from(schema.localActorKeys), saved);
    });
  });
  it("publishes canonical key ownership for uppercase UUID requests", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db);
      const id = "abcdefab-cdef-4abc-8def-abcdefabcdef" as Uuid;
      await db.insert(schema.localActors).values({ id });
      const iri = `https://test-instance.drfed.org/users/${id}`;
      await seedActors(db, {
        id,
        localId: id,
        iri,
        instanceId: "00000000-0000-4000-8000-000000000101" as Uuid,
        type: "Person",
        username: "uppercase-test",
        inboxUrl: `${iri}/inbox`,
        created: Temporal.Now.instant(),
      });
      const response = await federation.fetch(
        new Request(iri.replace(id, id.toUpperCase()), { headers: accept }),
        { contextData: undefined },
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.id, iri);
      assert.equal(body.publicKey.owner, iri);
      assert.equal(body.publicKey.id, `${iri}#main-key`);
      for (const key of body.assertionMethod) assert.equal(key.controller, iri);
    });
  });
  for (const requestOrigin of [
    "https://test-instance.drfed.org.",
    "https://test-instance.drfed.org:443",
    "http://test-instance.drfed.org",
    "http://test-instance.drfed.org:443",
  ]) {
    it(`publishes stored key ownership when requested from ${requestOrigin}`, async () => {
      await withFederation(async ({ db, federation }) => {
        await seedLocalActor(db);
        const response = await federation.fetch(
          new Request(new URL(new URL(actorIri).pathname, requestOrigin), {
            headers: accept,
          }),
          { contextData: undefined },
        );
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.id, actorIri);
        assert.equal(body.publicKey.owner, actorIri);
        assert.equal(body.publicKey.id, `${actorIri}#main-key`);
        assert.deepEqual(
          body.assertionMethod.map((key: { id: string }) => key.id),
          [`${actorIri}#multikey-1`, `${actorIri}#multikey-2`],
        );
        for (const key of body.assertionMethod) {
          assert.equal(key.controller, actorIri);
        }
      });
    });
  }
  it("preserves stored keys when repairing a missing kind and when deleted", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db);
      const [rsa] = await db
        .select()
        .from(schema.localActorKeys)
        .where(eq(schema.localActorKeys.type, "RSASSA-PKCS1-v1_5"));
      await db
        .delete(schema.localActorKeys)
        .where(eq(schema.localActorKeys.type, "Ed25519"));
      const ctx = federation.createContext(new URL(actorIri), undefined);
      assert.equal(
        (await ensureActorKeyPairs(db, ctx, localActorId)).length,
        2,
      );
      assert.deepEqual(
        (
          await db
            .select()
            .from(schema.localActorKeys)
            .where(eq(schema.localActorKeys.type, "RSASSA-PKCS1-v1_5"))
        )[0],
        rsa,
      );
      await db
        .update(schema.actors)
        .set({ deleted: Temporal.Now.instant() })
        .where(eq(schema.actors.id, localActorId));
      assert.equal(
        (await ensureActorKeyPairs(db, ctx, localActorId)).length,
        2,
      );
      await db
        .delete(schema.localActorKeys)
        .where(eq(schema.localActorKeys.type, "Ed25519"));
      assert.deepEqual(await ensureActorKeyPairs(db, ctx, localActorId), []);
      assert.equal(await db.$count(schema.localActorKeys), 1);
    });
  });
  for (const deletion of ["soft", "hard", "actor row"] as const) {
    it(`does not persist keys when ${deletion} deletion happens during generation`, async () => {
      await withFederation(async ({ db, federation }) => {
        await seedLocalActor(db, { keys: false });
        const ctx = federation.createContext(new URL(actorIri), undefined);
        let deleted = false;
        const pairs = await ensureActorKeyPairs(
          db,
          ctx,
          localActorId,
          async (type) => {
            if (!deleted) {
              deleted = true;
              if (deletion === "soft") {
                await db
                  .update(schema.actors)
                  .set({ deleted: Temporal.Now.instant() })
                  .where(eq(schema.actors.id, localActorId));
              } else if (deletion === "hard") {
                await db
                  .delete(schema.localActors)
                  .where(eq(schema.localActors.id, localActorId));
              } else {
                await db
                  .delete(schema.actors)
                  .where(eq(schema.actors.id, localActorId));
              }
            }
            return await generateCryptoKeyPair(type);
          },
        );
        assert.deepEqual(pairs, []);
        assert.equal(await db.$count(schema.localActorKeys), 0);
      });
    });
  }
  it("rejects missing, remote and wrong-host actors without storing keys", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db, { keys: false });
      await seedRemoteActor(db);
      const ctx = federation.createContext(new URL(actorIri), undefined);
      assert.deepEqual(await ensureActorKeyPairs(db, ctx, "invalid"), []);
      assert.deepEqual(await ensureActorKeyPairs(db, ctx, uuid()), []);
      assert.deepEqual(await ensureActorKeyPairs(db, ctx, remoteActorId), []);
      assert.deepEqual(
        await ensureActorKeyPairs(
          db,
          federation.createContext(new URL("https://other.example"), undefined),
          localActorId,
        ),
        [],
      );
      assert.equal(await db.$count(schema.localActorKeys), 0);
    });
  });
  it("uses the local row identity and enforces key storage constraints", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db, { keys: false });
      const localId = uuid();
      await db.insert(schema.localActors).values({ id: localId });
      await db
        .update(schema.actors)
        .set({ localId })
        .where(eq(schema.actors.id, localActorId));
      await seedActorKeys(db, localId);
      const ctx = federation.createContext(new URL(actorIri), undefined);
      assert.equal(
        (await ensureActorKeyPairs(db, ctx, localActorId)).length,
        2,
      );
      const [row] = await db.select().from(schema.localActorKeys);
      assert.equal(row!.localActorId, localId);
      await assert.rejects(db.insert(schema.localActorKeys).values(row!));
      await assert.rejects(
        db.update(schema.localActorKeys).set({
          publicKey: { ...row!.publicKey, d: "secret" } as NonNullable<
            typeof row
          >["publicKey"],
        }),
      );
      await db
        .delete(schema.localActors)
        .where(eq(schema.localActors.id, localId));
      assert.equal(await db.$count(schema.localActorKeys), 0);
      assert.deepEqual(await ensureActorKeyPairs(db, ctx, localActorId), []);
    });
  });
  it("coalesces generation and returns a competing persisted winner", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db, { keys: false });
      const ctx = federation.createContext(new URL(actorIri), undefined);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let count = 0;
      const candidates: Record<string, unknown> = {};
      const candidate = async (type?: "RSASSA-PKCS1-v1_5" | "Ed25519") => {
        count += 1;
        entered.resolve();
        await release.promise;
        const pair = await generateCryptoKeyPair(type);
        candidates[type!] = await exportJwk(pair.publicKey);
        return pair;
      };
      const first = ensureActorKeyPairs(db, ctx, localActorId, candidate);
      const second = ensureActorKeyPairs(db, ctx, localActorId, candidate);
      await entered.promise;
      await seedActorKeys(db, localActorId);
      release.resolve();
      const [one, two] = await Promise.all([first, second]);
      assert.equal(count, 2);
      assert.equal(one, two);
      assert.equal(one.length, 2);
      const rows = await db.select().from(schema.localActorKeys);
      assert.equal(rows.length, 2);
      for (const pair of one) {
        const type = pair.publicKey.algorithm.name;
        const stored = rows.find((row) => row.type === type)!;
        assert.deepEqual(await exportJwk(pair.publicKey), stored.publicKey);
        assert.deepEqual(await exportJwk(pair.privateKey), stored.privateKey);
        assert.notDeepEqual(candidates[type], stored.publicKey);
      }
    });
  });
  it("sanitizes failures and clears failed in-flight generation", async () => {
    await withFederation(async ({ db, federation }) => {
      await seedLocalActor(db, { keys: false });
      const ctx = federation.createContext(new URL(actorIri), undefined);
      await assert.rejects(
        ensureActorKeyPairs(db, ctx, localActorId, () =>
          Promise.reject(new Error("PRIVATE_SECRET")),
        ),
        (error: unknown) =>
          error instanceof Error &&
          error.message === "Could not load actor signing keys." &&
          error.cause == null,
      );
      assert.equal(await db.$count(schema.localActorKeys), 0);
      await seedActorKeys(db, localActorId);
      assert.equal(
        (await ensureActorKeyPairs(db, ctx, localActorId)).length,
        2,
      );
      await db
        .update(schema.localActorKeys)
        .set({ privateKey: { kty: "RSA", d: "PRIVATE_SECRET" } });
      await assert.rejects(
        ensureActorKeyPairs(db, ctx, localActorId),
        /Could not load actor signing keys/u,
      );
    });
  });
  it("prewarms through real task dispatch for each federation's own handle", async () => {
    await withTemporaryDatabase(async (db) => {
      await seedLocalActor(db, { keys: false });
      const queue = new KeyGenerationQueue();
      const federation = await createFederation(db, {
        kv: new MemoryKvStore(),
        queue: { task: queue },
        manuallyStartQueue: true,
        taskQueueResolution: "strict",
      });
      const ctx = federation.createContext(new URL(actorIri), undefined);
      await enqueueActorKeyGeneration(ctx, [localActorId]);
      assert.equal((await queue.getDepth()).queued, 1);
      const abort = new AbortController();
      const worker = federation.startQueue(undefined, {
        queue: "task",
        signal: abort.signal,
      });
      try {
        await assertEventually(
          async () => (await db.$count(schema.localActorKeys)) === 2,
        );
        await enqueueActorKeyGeneration(ctx, [localActorId]);
      } finally {
        abort.abort();
        await worker;
      }
      const otherQueue = new KeyGenerationQueue();
      const other = await createFederation(db, {
        kv: new MemoryKvStore(),
        queue: { task: otherQueue },
        manuallyStartQueue: true,
      });
      await enqueueActorKeyGeneration(
        other.createContext(new URL(actorIri), undefined),
        [localActorId],
      );
      assert.equal((await otherQueue.getDepth()).queued, 1);
      const noQueue = await createFederation(db, { kv: new MemoryKvStore() });
      await enqueueActorKeyGeneration(
        noQueue.createContext(new URL(actorIri), undefined),
        [localActorId],
      );
    });
  });
});
async function assertEventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop
    if (await check()) return;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  assert.fail("Background task did not finish.");
}
