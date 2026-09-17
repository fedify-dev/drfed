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
// Pagination requests depend on the preceding cursor.
// oxlint-disable no-await-in-loop
import assert from "node:assert/strict";
import { it } from "node:test";

import { promoteResource, schema, storeAddressing } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import { uuidV7 as uuid } from "@drfed/models/uuid";
import { eq } from "drizzle-orm";

import { withTestHarness } from "./harness.test.ts";
import {
  globalId,
  localActorId,
  remoteActorId,
  seedLocalActor,
  seedObjects,
  seedRemoteActor,
} from "./seed.test.ts";

it("separates a collection's declared total from its visible member count", async () => {
  await withTestHarness(async ({ db, post }) => {
    await seedLocalActor(db);
    await seedRemoteActor(db);
    const collectionReference =
      await db.query.actorCollectionReferences.findFirst({
        where: { actorId: remoteActorId, role: "featured" },
        with: { collection: true },
      });
    assert.ok(collectionReference);
    const { collection } = collectionReference;
    await db
      .update(schema.collections)
      .set({ totalItems: 42 })
      .where(eq(schema.collections.id, collection.id));
    await db.insert(schema.collectionItems).values({
      collectionId: collection.id,
      itemId: localActorId,
      position: 0,
    });
    const body = await (
      await post({
        query: `query($id: ID!) { node(id: $id) { ... on Collection { declaredTotalItems totalCount } } }`,
        variables: { id: globalId("Collection", collection.id) },
      })
    ).json();
    assert.deepEqual(body, {
      data: { node: { declaredTotalItems: 42, totalCount: 1 } },
    });
  });
});

for (const deleted of ["actor", "object"] as const) {
  it(`hides a deleted ${deleted} through resource targets, collections and activities`, async () => {
    // oxlint-disable-next-line max-statements
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);
      await seedRemoteActor(db);
      const hiddenId = uuid();
      const liveId = uuid();
      const hiddenIri = `https://test.example/${hiddenId}`;
      const actorIri = `https://test-instance.drfed.org/users/${localActorId}`;
      const followersIri = `${actorIri}/followers`;
      await seedObjects(db, [
        {
          id: hiddenId,
          actorId: localActorId,
          type: "Note",
          iri: hiddenIri,
          contentHtml: "hidden",
        },
        {
          id: liveId,
          actorId: remoteActorId,
          type: "Note",
          iri: `https://test.example/${liveId}`,
          contentHtml: "live",
          addressing: { to: [actorIri, hiddenIri, PUBLIC_IRI, followersIri] },
        },
      ]);
      const activity = await db.query.activities.findFirst({
        where: { objectId: hiddenId },
      });
      const collectionReference =
        await db.query.actorCollectionReferences.findFirst({
          where: { actorId: localActorId, role: "featured" },
          with: { collection: true },
        });
      const remoteCollectionReference =
        await db.query.actorCollectionReferences.findFirst({
          where: { actorId: remoteActorId, role: "featured" },
          with: { collection: true },
        });
      assert.ok(collectionReference);
      assert.ok(remoteCollectionReference);
      const { collection } = collectionReference;
      const { collection: remoteCollection } = remoteCollectionReference;
      const followers = await db.query.resources.findFirst({
        where: { iri: followersIri },
      });
      assert.ok(activity);
      assert.ok(followers);
      await db.insert(schema.collectionItems).values(
        [localActorId, hiddenId, liveId, activity.id].map(
          (itemId, position) => ({
            collectionId: collection.id,
            itemId,
            position,
          }),
        ),
      );
      // The live remote actor's collection lists the local actor's followers
      // collection, which must disappear along with the local actor.
      await db.insert(schema.collectionItems).values({
        collectionId: remoteCollection.id,
        itemId: followers.id,
        position: 0,
      });
      if (deleted === "actor") {
        await db
          .update(schema.actors)
          .set({ deleted: Temporal.Now.instant() })
          .where(eq(schema.actors.id, localActorId));
      } else {
        await db
          .update(schema.objects)
          .set({ deleted: Temporal.Now.instant() })
          .where(eq(schema.objects.id, hiddenId));
      }
      const body = await (
        await post({
          query: `query($live: ID!, $activity: ID!, $collection: ID!, $remote: ID!) {
          live: node(id: $live) { ... on Object { to { iri detail { ... on Actor { iri objects { totalCount } } ... on Collection { iri } } } } }
          activity: node(id: $activity) { ... on Activity { actor { uuid } object { iri detail { __typename } } } }
          collection: node(id: $collection) { ... on Collection { owner { uuid } totalCount } }
          collections: nodes(ids: [$collection]) { ... on Collection { totalCount } }
          remote: node(id: $remote) { ... on Collection { totalCount items { edges { node { iri } } } } }
        }`,
          variables: {
            live: globalId("Object", liveId),
            activity: globalId("Activity", activity.id),
            collection: globalId("Collection", collection.id),
            remote: globalId("Collection", remoteCollection.id),
          },
        })
      ).json();
      assert.equal(body.errors, undefined);
      assert.equal(body.data.live.to.length, 4);
      assert.equal(body.data.live.to[1].iri, hiddenIri);
      assert.equal(body.data.live.to[1].detail, null);
      assert.equal(body.data.live.to[2].iri, PUBLIC_IRI);
      assert.deepEqual(
        body.data.activity,
        deleted === "actor"
          ? null
          : {
              actor: { uuid: localActorId },
              object: { iri: hiddenIri, detail: null },
            },
      );
      // A deleted actor hides its collections everywhere, like the actor
      // node itself: node, nodes, and addressing targets.
      assert.deepEqual(
        body.data.collection,
        deleted === "actor"
          ? null
          : { owner: { uuid: localActorId }, totalCount: 3 },
      );
      assert.deepEqual(
        body.data.collections,
        deleted === "actor" ? [null] : [{ totalCount: 3 }],
      );
      assert.deepEqual(
        body.data.live.to[3].detail,
        deleted === "actor" ? null : { iri: followersIri },
      );
      assert.deepEqual(
        body.data.remote,
        deleted === "actor"
          ? { totalCount: 0, items: { edges: [] } }
          : {
              totalCount: 1,
              items: { edges: [{ node: { iri: followersIri } }] },
            },
      );
      if (deleted === "actor") {
        assert.equal(body.data.live.to[0].detail, null);
        return;
      }
      const seen: string[] = [];
      let after: string | null = null;
      for (let page = 0; page < 4; page += 1) {
        const result: {
          errors?: unknown;
          data: {
            node: {
              items: {
                edges: { cursor: string; node: { iri: string } }[];
                pageInfo: { hasNextPage: boolean };
              };
            };
          };
        } = await (
          await post({
            query: `query($id: ID!, $after: String) { node(id: $id) { ... on Collection { items(first: 1, after: $after) { edges { cursor node { iri } } pageInfo { hasNextPage } } } } }`,
            variables: { id: globalId("Collection", collection.id), after },
          })
        ).json();
        assert.equal(result.errors, undefined);
        const connection = result.data.node.items;
        assert.equal(connection.edges.length, 1);
        const edge = connection.edges[0];
        assert.ok(edge);
        seen.push(edge.node.iri);
        if (!connection.pageInfo.hasNextPage) break;
        after = edge.cursor;
      }
      assert.equal(seen.length, 3);
      assert.ok(!seen.includes(hiddenIri));
    });
  });
}

it("hides Create relations authored by a deleted actor", async () => {
  await withTestHarness(async ({ db, post }) => {
    await seedLocalActor(db);
    await seedRemoteActor(db);
    const id = uuid();
    await seedObjects(db, {
      id,
      actorId: remoteActorId,
      type: "Note",
      iri: `https://test.example/${id}`,
      contentHtml: "live",
    });
    await db.update(schema.activities).set({ actorId: localActorId });
    await db
      .update(schema.actors)
      .set({ deleted: Temporal.Now.instant() })
      .where(eq(schema.actors.id, localActorId));
    const body = await (
      await post({
        query: `query($id: ID!) { node(id: $id) { ... on Object { uuid activities(type: Create) { edges { node { actor { uuid } } } } } } }`,
        variables: { id: globalId("Object", id) },
      })
    ).json();
    assert.deepEqual(body, {
      data: { node: { uuid: id, activities: { edges: [] } } },
    });
  });
});

it("preserves resource identity through promotion and typed-node refetch", async () => {
  await withTestHarness(async ({ db, post }) => {
    await seedLocalActor(db);
    const id = uuid();
    const iri = "https://remote.example/unresolved";
    await seedObjects(db, {
      id,
      actorId: localActorId,
      type: "Note",
      iri: `https://test.example/${id}`,
      contentHtml: "reference",
      addressing: { to: [iri] },
    });
    const query = `query($id: ID!) { node(id: $id) { ... on Object { to { id iri kind detail { __typename } } } } }`;
    const before = await (
      await post({ query, variables: { id: globalId("Object", id) } })
    ).json();
    assert.equal(before.errors, undefined);
    const resource = before.data.node.to[0];
    assert.deepEqual(resource, {
      id: resource.id,
      iri,
      kind: "unknown",
      detail: null,
    });
    await promoteResource(db, iri, "collection", async (tx, row) => {
      await tx
        .insert(schema.collections)
        .values({ id: row.id, type: "OrderedCollection" });
    });
    const refetched = await (
      await post({
        query: `query($id: ID!) { node(id: $id) { id ... on Resource { kind detail { ... on Collection { type resource { id } } } } } }`,
        variables: { id: resource.id },
      })
    ).json();
    assert.deepEqual(refetched, {
      data: {
        node: {
          id: resource.id,
          kind: "collection",
          detail: { type: "OrderedCollection", resource: { id: resource.id } },
        },
      },
    });
    const after = await (
      await post({ query, variables: { id: globalId("Object", id) } })
    ).json();
    assert.deepEqual(after, {
      data: {
        node: {
          to: [
            {
              ...resource,
              kind: "collection",
              detail: { __typename: "Collection" },
            },
          ],
        },
      },
    });
  });
});

it("lists every referencing activity and classifies the explicitly selected activity", async () => {
  await withTestHarness(async ({ db, post }) => {
    await seedLocalActor(db);
    const id = uuid();
    const firstId = uuid();
    const secondId = uuid();
    const followers = `https://test-instance.drfed.org/users/${localActorId}/followers`;
    await seedObjects(db, {
      id,
      activityId: firstId,
      actorId: localActorId,
      type: "Note",
      iri: `https://test.example/${id}`,
      contentHtml: "no addressing",
      addressing: {},
      published: Temporal.Instant.from("2026-01-01T00:00:00Z"),
    });
    await db.transaction(async (tx) => {
      await storeAddressing(tx, firstId, { to: [PUBLIC_IRI] });
    });
    await promoteResource(
      db,
      `https://test.example/${secondId}`,
      "activity",
      async (tx, resource) => {
        await tx.insert(schema.activities).values({
          id: resource.id,
          actorId: localActorId,
          objectId: id,
          type: "Create",
          published: Temporal.Instant.from("2026-01-02T00:00:00Z"),
        });
        await storeAddressing(tx, resource.id, { to: [followers] });
      },
      secondId,
    );
    const body = await (
      await post({
        query: `query($id: ID!) { node(id: $id) { ... on Object { activities(type: Create) { edges { node { id expectedClassifications { implementation classification } } } } all: activities { edges { node { id } } } } } }`,
        variables: { id: globalId("Object", id) },
      })
    ).json();
    assert.deepEqual(body, {
      data: {
        node: {
          activities: {
            edges: [
              {
                node: {
                  id: globalId("Activity", firstId),
                  expectedClassifications: [
                    { implementation: "MASTODON", classification: "public" },
                    { implementation: "MISSKEY", classification: "specified" },
                  ],
                },
              },
              {
                node: {
                  id: globalId("Activity", secondId),
                  expectedClassifications: [
                    { implementation: "MASTODON", classification: "private" },
                    { implementation: "MISSKEY", classification: "specified" },
                  ],
                },
              },
            ],
          },
          all: {
            edges: [
              { node: { id: globalId("Activity", firstId) } },
              { node: { id: globalId("Activity", secondId) } },
            ],
          },
        },
      },
    });
  });
});
