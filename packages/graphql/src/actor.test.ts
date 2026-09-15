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

// oxlint-disable max-lines
// Cursor pagination tests walk pages sequentially.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";

import { schema } from "@drfed/models";
import { type Uuid, uuidV7 as uuid } from "@drfed/models/uuid";
import { describe, it } from "@logtape/testing-node/autoload";
import { eq } from "drizzle-orm";

import { withTestHarness } from "./harness.test.ts";
import {
  created,
  globalId,
  localActorId,
  localInstanceId,
  ok,
  remoteActorId,
  remoteInstanceId,
  seedActors,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedLocalInstance,
  seedObjects,
  seedRemoteActor,
} from "./seed.test.ts";

const generateActorsMutation = `
  mutation GenerateActors($instance: ID!, $size: Int!) {
    generateActors(instance: $instance, size: $size) {
      resultType: __typename
      ... on CreateActorsSuccess {
        actors {
          uuid
          iri
          username
          local {
            uuid
          }
        }
      }
      ... on CreateActorsError {
        type
        message
      }
    }
  }
`;

const actorQuery = `
  query Actor($id: ID!) {
    node(id: $id) {
      ... on Actor {
        id
        uuid
        iri
        handle
        type
        username
        instance {
          uuid
          host
        }
        local {
          avatar
          header
        }
        inboxUrl
        outbox { iri }
        avatarUrl
        followers { iri }
        following { iri }
        headerUrl
        profileUrl
        featured { iri }
        created
      }
    }
  }
`;

describe("Mutation.generateActors", () => {
  it("creates local actors", async () => {
    await withTestHarness(async ({ db, post }) => {
      const auth = await seedAuthenticatedLocalInstance(db);

      const response = await post(
        {
          query: generateActorsMutation,
          variables: {
            instance: globalId("Instance", localInstanceId),
            size: 2,
          },
        },
        auth,
      );

      assert.equal(response.status, ok);
      const body = await response.json();
      assert.equal(body.errors, undefined);
      assert.equal(body.data.generateActors.resultType, "CreateActorsSuccess");
      assert.equal(body.data.generateActors.actors.length, 2);
      assert.ok(
        body.data.generateActors.actors.every(
          (actor: {
            iri: unknown;
            local: { uuid: unknown } | null;
            username: unknown;
            uuid: unknown;
          }) =>
            typeof actor.uuid === "string" &&
            typeof actor.username === "string" &&
            typeof actor.iri === "string" &&
            typeof actor.local?.uuid === "string",
        ),
      );
      assert.deepStrictEqual(
        body.data.generateActors.actors.map(
          (actor: { iri: string }) => actor.iri,
        ),
        body.data.generateActors.actors.map(
          (actor: { uuid: string }) =>
            `https://test-instance.drfed.org/users/${actor.uuid}`,
        ),
      );

      const actors = await db.select().from(schema.actors);
      assert.equal(actors.length, 2);
      assert.equal(
        actors.every(
          (actor) =>
            actor.instanceId === localInstanceId &&
            actor.localId != null &&
            actor.type === "Person",
        ),
        true,
      );

      const localActors = await db.select().from(schema.localActors);
      assert.equal(localActors.length, 2);
      assert.deepEqual(
        new Set(localActors.map(({ id }) => id)),
        new Set(actors.map(({ localId }) => localId)),
      );
    });
  });

  it("builds actor URIs from the stored host and the root scheme", async () => {
    // The stored host deliberately disagrees with what recomposing
    // `${slug}.${root}` would produce, and the root origin is HTTP on a
    // non-default port.  Both are visible in the generated URIs only if the
    // resolver reads `instances.host` and takes the scheme from the root
    // origin, rather than assembling `https://${slug}.${root}` itself.
    await withTestHarness(async ({ db, post }) => {
      const auth = await seedAuthenticatedLocalInstance(db);
      await db
        .update(schema.instances)
        .set({ host: "renamed.drfed.localhost:8888" })
        .where(eq(schema.instances.id, localInstanceId));

      const response = await post(
        {
          query: generateActorsMutation,
          variables: {
            instance: globalId("Instance", localInstanceId),
            size: 1,
          },
        },
        auth,
      );

      assert.equal(response.status, ok);
      const body = await response.json();
      assert.equal(body.errors, undefined);
      assert.equal(body.data.generateActors.resultType, "CreateActorsSuccess");
      const [generated] = body.data.generateActors.actors;
      assert.equal(
        generated.iri,
        `http://renamed.drfed.localhost:8888/users/${generated.uuid}`,
      );

      const [actor] = await db.select().from(schema.actors);
      assert.ok(actor != null);
      for (const url of [actor.inboxUrl, actor.profileUrl]) {
        assert.ok(url != null);
        assert.equal(
          new URL(url).origin,
          "http://renamed.drfed.localhost:8888",
          url,
        );
      }
    }, new URL("http://drfed.localhost:8888"));
  });
});

describe("Actor", () => {
  it("returns a local actor", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);

      const response = await post({
        query: actorQuery,
        variables: { id: globalId("Actor", localActorId) },
      });

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), {
        data: {
          node: {
            id: globalId("Actor", localActorId),
            uuid: localActorId,
            iri: `https://test-instance.drfed.org/users/${localActorId}`,
            handle: "@alice@test-instance.drfed.org",
            type: "Person",
            username: "alice",
            instance: {
              uuid: localInstanceId,
              host: "test-instance.drfed.org",
            },
            local: {
              avatar: "avatar.png",
              header: "header.png",
            },
            inboxUrl: `https://test-instance.drfed.org/users/${localActorId}/inbox`,
            outbox: {
              iri: `https://test-instance.drfed.org/users/${localActorId}/outbox`,
            },
            avatarUrl: `https://test-instance.drfed.org/users/${localActorId}/avatar/avatar.png`,
            followers: {
              iri: `https://test-instance.drfed.org/users/${localActorId}/followers`,
            },
            following: {
              iri: `https://test-instance.drfed.org/users/${localActorId}/following`,
            },
            headerUrl: `https://test-instance.drfed.org/users/${localActorId}/header/header.png`,
            profileUrl: "https://test-instance.drfed.org/@alice",
            featured: {
              iri: `https://test-instance.drfed.org/users/${localActorId}/featured`,
            },
            created: created.toString(),
          },
        },
      });
    });
  });

  it("returns a remote actor", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedRemoteActor(db);

      const response = await post({
        query: actorQuery,
        variables: { id: globalId("Actor", remoteActorId) },
      });

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), {
        data: {
          node: {
            id: globalId("Actor", remoteActorId),
            uuid: remoteActorId,
            iri: "https://remote.example.com/users/bob",
            handle: "@bob@remote.example.com",
            type: "Service",
            username: "bob",
            instance: {
              uuid: remoteInstanceId,
              host: "remote.example.com",
            },
            local: null,
            inboxUrl: "https://remote.example.com/users/bob/inbox",
            outbox: { iri: "https://remote.example.com/users/bob/outbox" },
            avatarUrl: "https://remote.example.com/users/bob/avatar.png",
            followers: {
              iri: "https://remote.example.com/users/bob/followers",
            },
            following: {
              iri: "https://remote.example.com/users/bob/following",
            },
            headerUrl: "https://remote.example.com/users/bob/header.png",
            profileUrl: "https://remote.example.com/@bob",
            featured: { iri: "https://remote.example.com/users/bob/featured" },
            created: created.toString(),
          },
        },
      });
    });
  });

  it("hides deleted actors from node and nodes while keeping live ones", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);
      await seedRemoteActor(db);
      await db
        .update(schema.actors)
        .set({ deleted: Temporal.Now.instant() })
        .where(eq(schema.actors.id, localActorId));
      const query = `query($live: ID!, $deleted: ID!) {
        live: node(id: $live) { ... on Actor { uuid instance { uuid } } }
        deleted: node(id: $deleted) { ... on Actor { uuid instance { uuid } } }
        nodes(ids: [$live, $deleted]) { ... on Actor { uuid } }
      }`;
      const body = await (
        await post({
          query,
          variables: {
            live: globalId("Actor", remoteActorId),
            deleted: globalId("Actor", localActorId),
          },
        })
      ).json();
      assert.deepEqual(body, {
        data: {
          live: { uuid: remoteActorId, instance: { uuid: remoteInstanceId } },
          deleted: null,
          nodes: [{ uuid: remoteActorId }, null],
        },
      });
    });
  });
});

const instanceActorsQuery = `query($instance: ID!) {
  node(id: $instance) {
    ... on Instance {
      actors {
        totalCount
        edges { node { uuid objects { totalCount edges { node { uuid } } } } }
      }
    }
  }
}`;

function localActorValues(id: Uuid, username: string) {
  const iri = `https://test-instance.drfed.org/users/${id}`;
  return {
    id,
    localId: id,
    instanceId: localInstanceId as Uuid,
    type: "Person" as const,
    username,
    iri,
    inboxUrl: `${iri}/inbox`,
  };
}

// Regression test for
// https://github.com/fedify-dev/drfed/pull/73#discussion_r4005163257:
// `filterDeleted` only applies to `node`/`nodes`, so a soft-deleted actor is
// still reachable through `Instance.actors` and its `objects` connection
// still returns content.
describe("Instance.actors with a deleted actor", () => {
  it("hides the deleted actor and its objects while keeping live ones", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);
      const carolId = "00000000-0000-4000-8000-000000000203" as const;
      await db.insert(schema.localActors).values({ id: carolId });
      await seedActors(db, localActorValues(carolId, "carol"));
      const hiddenObjectId = uuid();
      const liveObjectId = uuid();
      await seedObjects(
        db,
        [hiddenObjectId, liveObjectId].map((id) => ({
          id,
          actorId: id === hiddenObjectId ? localActorId : carolId,
          type: "Note" as const,
          iri: `https://test-instance.drfed.org/objects/${id}`,
          contentHtml: "test",
        })),
      );
      await db
        .update(schema.actors)
        .set({ deleted: Temporal.Now.instant() })
        .where(eq(schema.actors.id, localActorId));
      const body = await (
        await post({
          query: instanceActorsQuery,
          variables: { instance: globalId("Instance", localInstanceId) },
        })
      ).json();
      assert.deepEqual(body, {
        data: {
          node: {
            actors: {
              totalCount: 1,
              edges: [
                {
                  node: {
                    uuid: carolId,
                    objects: {
                      totalCount: 1,
                      edges: [{ node: { uuid: liveObjectId } }],
                    },
                  },
                },
              ],
            },
          },
        },
      });
    });
  });
});

// Regression test for
// https://github.com/fedify-dev/drfed/pull/73#discussion_r4005163244:
// Preserve microseconds and distinguish equal timestamps using the actor ID.
describe("Instance.actors cursor precision", () => {
  it("returns every actor whose created time carries microseconds", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalInstance(db);
      const ids = Array.from({ length: 3 }, () => uuid());
      await seedActors(
        db,
        ids.map((id) => ({
          ...localActorValues(id, id),
          localId: null,
          created: Temporal.Instant.from("2026-09-14T12:00:00.123456Z"),
        })),
      );
      const query = `query($instance: ID!, $after: String) { node(id: $instance) { ... on Instance { actors(first: 1, after: $after) { edges { cursor node { uuid } } pageInfo { hasNextPage } } } } }`;
      const seen: string[] = [];
      let after: string | null = null;
      let hasNextPage = true;
      for (let page = 0; hasNextPage && page <= ids.length; page += 1) {
        const body = await (
          await post({
            query,
            variables: {
              instance: globalId("Instance", localInstanceId),
              after,
            },
          })
        ).json();
        assert.equal(body.errors, undefined);
        const connection = body.data.node.actors;
        if (connection.edges.length === 0) break;
        seen.push(
          ...connection.edges.map(
            (edge: { node: { uuid: string } }) => edge.node.uuid,
          ),
        );
        ({ hasNextPage } = connection.pageInfo);
        ({ cursor: after } = connection.edges.at(-1));
      }
      assert.deepEqual(seen, [...ids].sort().reverse());
      assert.equal(hasNextPage, false);
    });
  });
});

it("resolves multiple actor roles referencing a shared collection", async () => {
  await withTestHarness(async ({ db, post }) => {
    await seedLocalActor(db);
    await seedRemoteActor(db);
    const outbox = await db.query.collections.findFirst({
      where: { ownerActorId: localActorId, role: "outbox" },
      with: { resource: true },
    });
    assert.ok(outbox);
    await db
      .update(schema.actorCollectionReferences)
      .set({ collectionId: outbox.id })
      .where(eq(schema.actorCollectionReferences.role, "featured"));
    const response = await (
      await post({
        query: `query($local: ID!, $remote: ID!) { local: node(id: $local) { ... on Actor { outbox { id iri } featured { id iri } } } remote: node(id: $remote) { ... on Actor { featured { id iri } } } }`,
        variables: {
          local: globalId("Actor", localActorId),
          remote: globalId("Actor", remoteActorId),
        },
      })
    ).json();
    assert.equal(response.errors, undefined);
    assert.deepEqual(response.data.local.featured, response.data.local.outbox);
    assert.deepEqual(response.data.remote.featured, response.data.local.outbox);
  });
});

it("hides deleted local actor details from node and nodes", async () => {
  await withTestHarness(async ({ db, post }) => {
    await seedLocalActor(db);
    await db
      .update(schema.localActors)
      .set({ avatar: "avatar.png", header: "header.png" });
    const query = `query($id: ID!) {
      node(id: $id) { ... on LocalActor { uuid avatar header } }
      nodes(ids: [$id]) { ... on LocalActor { uuid avatar header } }
    }`;
    const variables = { id: globalId("LocalActor", localActorId) };
    const live = {
      uuid: localActorId,
      avatar: "avatar.png",
      header: "header.png",
    };
    assert.deepEqual(await (await post({ query, variables })).json(), {
      data: { node: live, nodes: [live] },
    });
    await db
      .update(schema.actors)
      .set({ deleted: Temporal.Now.instant() })
      .where(eq(schema.actors.id, localActorId));
    assert.deepEqual(await (await post({ query, variables })).json(), {
      data: { node: null, nodes: [null] },
    });
  });
});
