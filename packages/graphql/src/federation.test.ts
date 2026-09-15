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

import { createYogaServer } from "@drfed/graphql";
import createFederation, { buildFederation } from "@drfed/graphql/federation";
import { schema } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import { type Uuid, uuidV7 as uuid } from "@drfed/models/uuid";
import { MemoryKvStore } from "@fedify/fedify";
import { Object as APObject, Create } from "@fedify/vocab";
import { describe, it } from "@logtape/testing-node/autoload";
import { eq, sql } from "drizzle-orm";

import { withTemporaryDatabase, withTestHarness } from "./harness.test.ts";
import {
  globalId,
  localActorId,
  remoteActorId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedObjects,
  seedRemoteActor,
} from "./seed.test.ts";

const origin = new URL("https://drfed.test");

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
        createYogaServer(db, federation, { mailer, loginOrigins }),
      );
    });
  });
});

const actorIri = `https://test-instance.drfed.org/users/${localActorId}`;
const createIri = (id: string) =>
  `https://test-instance.drfed.org/ap/creates/${id}`;
const accept = { accept: "application/activity+json" };

function values(id: string) {
  return {
    id: id as Uuid,
    actorId: localActorId as Uuid,
    iri: `${actorIri}/${id}`,
    type: "Note" as const,
    contentHtml: "<p>Hello</p>",
  };
}

describe("ActivityPub objects", () => {
  for (const publicProperty of ["to", "cc"] as const) {
    it(`serves ${publicProperty} Public objects with contentMap and recipients`, async () => {
      await withTestHarness(async ({ db, federation }) => {
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
      await withTestHarness(async ({ db, federation }) => {
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
    await withTestHarness(async ({ db, federation }) => {
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
      // Fedify serializes generic object tombstones with HTTP 200.
      assert.equal(deleted.status, 200);
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
      await withTestHarness(async ({ db, federation }) => {
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
      await withTestHarness(async ({ db, federation }) => {
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
          new Request(createIri(object.id), { headers: accept }),
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
            id: createIri(object.id),
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
      await withTestHarness(async ({ db, federation }) => {
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
              : createIri(object.id);
        const response = await federation.fetch(
          new Request(iri, { headers: accept }),
          { contextData: undefined },
        );
        assert.equal(response.status, 404);
      });
    });
  }
  it("rejects Create requests from another host", async () => {
    await withTestHarness(async ({ db, federation }) => {
      await seedLocalActor(db);
      const object = values(uuid());
      await seedObjects(db, object);
      const response = await federation.fetch(
        new Request(
          createIri(object.id).replace(
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
    await withTestHarness(async ({ db, federation }) => {
      await seedLocalActor(db);
      const ids = Array.from({ length: 23 }, () => uuid());
      await seedObjects(
        db,
        ids.map((id, index) => ({
          ...values(id),
          addressing:
            index === 22
              ? { to: [`${actorIri}/followers`] }
              : index === 20
                ? { to: [`${actorIri}/followers`], cc: [PUBLIC_IRI] }
                : { to: [PUBLIC_IRI] },
          deleted: index === 21 ? Temporal.Now.instant() : null,
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
          id: createIri(ids[20]!),
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
    await withTestHarness(async ({ db, federation }) => {
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

const createMutation = `mutation Create($actor: ID!, $addressing: AddressingInput!) {
  createObject(actor: $actor, contentHtml: "<p>Hello</p>", addressing: $addressing) {
    ... on Object { uuid }
    ... on CreateObjectError { errorType: type message }
  }
}`;

// Regression tests for
// https://github.com/fedify-dev/drfed/pull/73#discussion_r4005163252:
// The outbox counter must match its page predicate independently of postsCount.
describe("ActivityPub outbox totalItems", () => {
  for (const scenario of ["followers", "deleted"] as const) {
    it(`does not count ${scenario} objects that outbox pages never return`, async () => {
      await withTestHarness(async ({ db, federation, post }) => {
        const auth = await seedAuthenticatedLocalInstance(db);
        await seedLocalActor(db);
        const body = await (
          await post(
            {
              query: createMutation,
              variables: {
                actor: globalId("Actor", localActorId),
                addressing:
                  scenario === "followers"
                    ? { to: [`${actorIri}/followers`] }
                    : { to: [PUBLIC_IRI] },
              },
            },
            auth,
          )
        ).json();
        assert.equal(body.errors, undefined);
        assert.equal(body.data.createObject.errorType, undefined);
        if (scenario === "deleted") {
          await db
            .update(schema.objects)
            .set({ deleted: Temporal.Now.instant() })
            .where(eq(schema.objects.id, body.data.createObject.uuid));
        }
        const fetchJson = async (iri: string) => {
          const response = await federation.fetch(
            new Request(iri, { headers: accept }),
            { contextData: undefined },
          );
          assert.equal(response.status, 200);
          return await response.json();
        };
        const page = await fetchJson(`${actorIri}/outbox?cursor=`);
        assert.deepEqual(page.orderedItems ?? [], []);
        const collection = await fetchJson(`${actorIri}/outbox`);
        assert.equal(collection.totalItems, 0);
      });
    });
  }
});

describe("stored collection membership and independent activity addressing", () => {
  it("serves backfilled Create IRIs and uses activity addressing for outbox and Create", async () => {
    await withTestHarness(async ({ db, federation }) => {
      await seedLocalActor(db);
      const object = values(uuid());
      await seedObjects(db, object);
      const activity = await db.query.activities.findFirst({
        where: { objectId: object.id },
        with: { resource: true },
      });
      assert.ok(activity);
      assert.notEqual(activity.id, object.id);
      assert.equal(activity.resource.iri, createIri(object.id));
      const fetch = (iri: string) =>
        federation.fetch(new Request(iri, { headers: accept }), {
          contextData: undefined,
        });
      assert.equal((await fetch(createIri(object.id))).status, 200);
      await db
        .delete(schema.addressing)
        .where(eq(schema.addressing.sourceId, activity.id));
      assert.equal((await fetch(createIri(object.id))).status, 404);
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
  it("reads collection_items for followers, following, featured and GraphQL items", async () => {
    await withTestHarness(async ({ db, federation, post }) => {
      await seedLocalActor(db);
      await seedRemoteActor(db);
      const fetch = (iri: string) =>
        federation.fetch(new Request(iri, { headers: accept }), {
          contextData: undefined,
        });
      for (const role of ["followers", "following", "featured"] as const) {
        const collection = await db.query.collections.findFirst({
          where: { ownerActorId: localActorId, role },
        });
        assert.ok(collection);
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
      const body = await (
        await post({
          query: `query($id: ID!) { node(id: $id) { ... on Actor { followers { kind role totalCount items(first: 1) { edges { cursor node { kind iri ... on Actor { username } } } pageInfo { hasNextPage } } } } } }`,
          variables: { id: globalId("Actor", localActorId) },
        })
      ).json();
      assert.equal(body.errors, undefined);
      assert.equal(body.data.node.followers.totalCount, 1);
      assert.deepEqual(body.data.node.followers.items.edges[0].node, {
        kind: "actor",
        iri: "https://remote.example.com/users/bob",
        username: "bob",
      });
    });
  });
});
