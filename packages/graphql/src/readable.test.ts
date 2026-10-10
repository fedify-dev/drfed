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

// Each viewer reads the same stored rows in turn.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Database } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import type { Uuid } from "@drfed/models/uuid";

import {
  type Documents,
  addActor,
  createOf,
  createRecorder,
  hostB,
  hostC,
  otherInstanceId,
  seedAccount,
  seedOtherInstance,
  signed,
  thirdInstanceId,
} from "./activity-delivery/inbox-fixture.test.ts";
import { type TestHarness, withTestHarness } from "./harness.test.ts";
import {
  accepted,
  globalId,
  localActorId,
  localInstanceId,
  remoteActorId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedObjects,
  seedRemoteActor,
} from "./seed.test.ts";

const aliceIri = "https://remote.example/users/alice";
const localActorIri = `https://test-instance.drfed.org/users/${localActorId}`;
const direct = { to: [localActorIri], cc: [] };

const resourceGlobalId = (id: string): string =>
  Buffer.from(`Resource:${id}`).toString("base64");

const idOf = async (db: Database, iri: string): Promise<Uuid> => {
  const resource = await db.query.resources.findFirst({ where: { iri } });
  assert.ok(resource != null, iri);
  return resource.id;
};

/**
 * Run a query and assert it raised no errors.
 * @returns The data.
 */
async function read(
  graphql: TestHarness["post"],
  query: string,
  variables: Record<string, unknown>,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const { data, errors } = (await (
    await graphql({ query, variables }, init)
  ).json()) as { data?: Record<string, unknown>; errors?: unknown };
  assert.equal(errors, undefined);
  assert.ok(data != null);
  return data;
}

/**
 * Seed the viewers that may and may not read what instance A received.
 * @returns The request options that authenticate as each.
 */
async function seedViewers(db: Database) {
  const member = await seedAuthenticatedLocalInstance(db);
  await seedLocalActor(db);
  await seedOtherInstance(db);
  return {
    member,
    admin: await seedAccount(db, "admin", { admin: true }),
    pending: await seedAccount(db, "pending", {
      member: { instanceId: localInstanceId, accepted: null },
    }),
    stranger: await seedAccount(db, "stranger"),
    other: await seedAccount(db, "other", {
      member: { instanceId: otherInstanceId, accepted },
    }),
  };
}

const contentQuery = `
  query ($activity: ID!, $object: ID!, $resource: ID!, $actor: ID!) {
    activity: node(id: $activity) {
      ... on Activity {
        document
        object { detail { ... on Object { contentHtml document } } }
      }
    }
    object: node(id: $object) { ... on Object { contentHtml document } }
    resource: node(id: $resource) { ... on Resource { iri } }
    nodes(ids: [$activity, $object, $resource]) { id }
    actor: node(id: $actor) {
      ... on Actor {
        objects(first: 10) { totalCount edges { node { contentHtml } } }
      }
    }
  }
`;

describe("Reading received content", () => {
  it("shows a Create sent to a local actor alone only to the receiving instance's members and administrators", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      const viewers = await seedViewers(db);
      const documents: Documents = new Map();
      const alice = await addActor(documents, aliceIri);
      const { send } = await createRecorder(db, documents);
      const body = createOf(alice.iri, "1", {
        activity: direct,
        object: direct,
      });
      assert.equal((await send(await signed(alice, body))).status, 202);
      const activityId = await idOf(db, "https://remote.example/activities/1");
      const objectId = await idOf(db, "https://remote.example/notes/1");
      const variables = {
        activity: globalId("Activity", activityId),
        object: globalId("Object", objectId),
        resource: resourceGlobalId(activityId),
        actor: globalId("Actor", await idOf(db, aliceIri)),
      };

      for (const viewer of [
        undefined,
        viewers.stranger,
        viewers.pending,
        viewers.other,
      ]) {
        assert.deepEqual(await read(graphql, contentQuery, variables, viewer), {
          activity: null,
          object: null,
          resource: null,
          nodes: [null, null, null],
          actor: { objects: { totalCount: 0, edges: [] } },
        });
      }
      for (const viewer of [viewers.member, viewers.admin]) {
        const data = await read(graphql, contentQuery, variables, viewer);
        const object = {
          contentHtml: "<p>1</p>",
          document: body.object,
        };
        assert.deepEqual(data.activity, {
          document: body,
          object: { detail: object },
        });
        assert.deepEqual(data.object, object);
        assert.equal((data.nodes as unknown[]).includes(null), false);
        assert.deepEqual(data.actor, {
          objects: {
            totalCount: 1,
            edges: [{ node: { contentHtml: "<p>1</p>" } }],
          },
        });
      }
      // The delivery a member reads names the activity it may read too.
      assert.deepEqual(
        await read(
          graphql,
          `query ($id: ID!) {
            node(id: $id) {
              ... on Instance {
                activityDeliveries(first: 1) {
                  edges { node { activity { iri } } }
                }
              }
            }
          }`,
          { id: globalId("Instance", localInstanceId) },
          viewers.member,
        ),
        {
          node: {
            activityDeliveries: {
              edges: [
                {
                  node: {
                    activity: { iri: "https://remote.example/activities/1" },
                  },
                },
              ],
            },
          },
        },
      );
    });
  });

  it("shows a Create every receiving instance's members, and no one else", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      const viewers = await seedViewers(db);
      await seedOtherInstance(db, {
        id: thirdInstanceId,
        slug: "third-instance",
        host: hostC,
      });
      const third = await seedAccount(db, "third", {
        member: { instanceId: thirdInstanceId, accepted },
      });
      const documents: Documents = new Map();
      const alice = await addActor(documents, aliceIri);
      const { send } = await createRecorder(db, documents);
      const body = createOf(alice.iri, "1", {
        activity: direct,
        object: direct,
      });
      for (const host of [undefined, hostB]) {
        assert.equal((await send(await signed(alice, body, host))).status, 202);
      }
      const query = `
        query ($activity: ID!, $object: ID!) {
          activity: node(id: $activity) { ... on Activity { document } }
          object: node(id: $object) { ... on Object { contentHtml } }
        }
      `;
      const variables = {
        activity: globalId(
          "Activity",
          await idOf(db, "https://remote.example/activities/1"),
        ),
        object: globalId(
          "Object",
          await idOf(db, "https://remote.example/notes/1"),
        ),
      };
      for (const viewer of [viewers.member, viewers.other]) {
        assert.deepEqual(await read(graphql, query, variables, viewer), {
          activity: { document: body },
          object: { contentHtml: "<p>1</p>" },
        });
      }
      assert.deepEqual(await read(graphql, query, variables, third), {
        activity: null,
        object: null,
      });
    });
  });

  it("shows an object anyone may read an activity referring to", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      await seedViewers(db);
      const documents: Documents = new Map();
      const alice = await addActor(documents, aliceIri);
      const { send } = await createRecorder(db, documents);
      // A public Create of an object addressed to one actor, and a Create
      // addressed to one actor of an object addressed to the public.
      const bodies = [
        createOf(alice.iri, "1", { object: direct }),
        createOf(alice.iri, "2", { activity: direct }),
      ];
      for (const body of bodies) {
        assert.equal((await send(await signed(alice, body))).status, 202);
      }
      const objects = await Promise.all(
        ["1", "2"].map(async (name) =>
          globalId(
            "Object",
            await idOf(db, `https://remote.example/notes/${name}`),
          ),
        ),
      );
      assert.deepEqual(
        await read(
          graphql,
          `query ($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Object { contentHtml activities(first: 10) { edges { node { document } } } }
            }
          }`,
          { ids: objects },
        ),
        {
          nodes: [
            {
              contentHtml: "<p>1</p>",
              activities: { edges: [{ node: { document: bodies[0] } }] },
            },
            // The activity is left out even though its object is not.
            { contentHtml: "<p>2</p>", activities: { edges: [] } },
          ],
        },
      );
    });
  });

  it("never shows a stored object through a later activity carrying another version of it", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      const viewers = await seedViewers(db);
      const documents: Documents = new Map();
      const alice = await addActor(documents, aliceIri);
      const { send } = await createRecorder(db, documents);
      const secret = createOf(alice.iri, "1", {
        activity: direct,
        object: { ...direct, content: "<p>SECRET OLD VERSION</p>" },
      });
      const redacted = createOf(alice.iri, "2", {
        object: {
          id: "https://remote.example/notes/1",
          content: "<p>REDACTED PUBLIC VERSION</p>",
        },
      });
      for (const body of [secret, redacted]) {
        assert.equal((await send(await signed(alice, body))).status, 202);
      }
      const objectId = await idOf(db, "https://remote.example/notes/1");
      const variables = {
        activity: globalId(
          "Activity",
          await idOf(db, "https://remote.example/activities/2"),
        ),
        object: globalId("Object", objectId),
        resource: resourceGlobalId(objectId),
        actor: globalId("Actor", await idOf(db, aliceIri)),
      };

      for (const viewer of [
        undefined,
        viewers.stranger,
        viewers.pending,
        viewers.other,
      ]) {
        assert.deepEqual(await read(graphql, contentQuery, variables, viewer), {
          activity: { document: redacted, object: null },
          object: null,
          resource: null,
          nodes: [{ id: variables.activity }, null, null],
          actor: { objects: { totalCount: 0, edges: [] } },
        });
      }
      const stored = {
        contentHtml: "<p>SECRET OLD VERSION</p>",
        document: secret.object,
      };
      for (const viewer of [viewers.member, viewers.admin]) {
        const data = await read(graphql, contentQuery, variables, viewer);
        assert.deepEqual(data.activity, {
          document: redacted,
          object: { detail: stored },
        });
        assert.deepEqual(data.object, stored);
      }
    });
  });

  it("never shows a stored object to an instance that received only another version of it", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      const viewers = await seedViewers(db);
      const documents: Documents = new Map();
      const alice = await addActor(documents, aliceIri);
      const { send } = await createRecorder(db, documents);
      const first = createOf(alice.iri, "1", {
        activity: direct,
        object: { ...direct, content: "<p>first</p>" },
      });
      const second = createOf(alice.iri, "2", {
        activity: direct,
        object: {
          ...direct,
          id: "https://remote.example/notes/1",
          content: "<p>second</p>",
        },
      });
      assert.equal((await send(await signed(alice, first))).status, 202);
      assert.equal(
        (await send(await signed(alice, second, hostB))).status,
        202,
      );
      const query = `
        query ($activity: ID!, $object: ID!) {
          activity: node(id: $activity) { ... on Activity { document } }
          object: node(id: $object) { ... on Object { contentHtml } }
        }
      `;
      const variables = {
        activity: globalId(
          "Activity",
          await idOf(db, "https://remote.example/activities/2"),
        ),
        object: globalId(
          "Object",
          await idOf(db, "https://remote.example/notes/1"),
        ),
      };
      assert.deepEqual(await read(graphql, query, variables, viewers.other), {
        activity: { document: second },
        object: null,
      });
      assert.deepEqual(await read(graphql, query, variables, viewers.member), {
        activity: null,
        object: { contentHtml: "<p>first</p>" },
      });
    });
  });

  it("shows what a remote actor addresses to the public in any spelling", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      const { admin } = await seedViewers(db);
      await seedRemoteActor(db);
      const addressings = [
        { to: [PUBLIC_IRI] },
        { to: ["as:Public"] },
        { cc: ["Public"] },
        direct,
      ];
      const ids = addressings.map(
        (_, index) => `01990000-0000-7000-8000-00000000000${index}` as Uuid,
      );
      const activityIds = addressings.map(
        (_, index) => `01990000-0000-7000-8000-00000000001${index}` as Uuid,
      );
      for (const [index, addressing] of addressings.entries()) {
        await seedObjects(db, {
          id: ids[index]!,
          activityId: activityIds[index]!,
          iri: `https://remote.example.com/notes/${index}`,
          actorId: remoteActorId,
          type: "Note",
          contentHtml: `<p>${index}</p>`,
          addressing,
        });
      }
      const query = `
        query ($ids: [ID!]!, $actor: ID!) {
          nodes(ids: $ids) { id }
          actor: node(id: $actor) {
            ... on Actor {
              objects { totalCount }
              outbox { totalCount items(first: 10) { edges { node { iri } } } }
            }
          }
        }
      `;
      const variables = {
        ids: [
          ...ids.map((id) => globalId("Object", id)),
          ...activityIds.map((id) => globalId("Activity", id)),
        ],
        actor: globalId("Actor", remoteActorId),
      };
      const iris = activityIds.map(
        (id) => `https://remote.example.com/ap/creates/${id}`,
      );
      // The outbox lists the newest first; only membership matters here.
      const summary = (data: Record<string, unknown>) => {
        const { objects, outbox } = data.actor as {
          objects: { totalCount: number };
          outbox: {
            totalCount: number;
            items: { edges: { node: { iri: string } }[] };
          };
        };
        return {
          objects: objects.totalCount,
          outbox: outbox.totalCount,
          items: new Set(outbox.items.edges.map(({ node }) => node.iri)),
        };
      };
      const anonymous = await read(graphql, query, variables);
      assert.deepEqual(
        (anonymous.nodes as unknown[]).map((node) => node != null),
        [true, true, true, false, true, true, true, false],
      );
      assert.deepEqual(summary(anonymous), {
        objects: 3,
        outbox: 3,
        items: new Set(iris.slice(0, 3)),
      });
      const all = await read(graphql, query, variables, admin);
      assert.equal((all.nodes as unknown[]).includes(null), false);
      assert.deepEqual(summary(all), {
        objects: 4,
        outbox: 4,
        items: new Set(iris),
      });
    });
  });

  it("hides the details of a resource the viewer may not read wherever it is referred to", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      const { admin } = await seedViewers(db);
      await seedRemoteActor(db);
      const hiddenId: Uuid = "01990000-0000-7000-8000-000000000001";
      const hiddenIri = "https://remote.example.com/notes/1";
      await seedObjects(db, {
        id: hiddenId,
        iri: hiddenIri,
        actorId: remoteActorId,
        type: "Note",
        contentHtml: "<p>hidden</p>",
        addressing: direct,
      });
      // A local object is readable whatever it addresses.
      const localId: Uuid = "01990000-0000-7000-8000-000000000002";
      await seedObjects(db, {
        id: localId,
        iri: `${localActorIri}/notes/1`,
        actorId: localActorId,
        type: "Note",
        contentHtml: "<p>local</p>",
        addressing: { to: [hiddenIri] },
      });
      const query = `
        query ($id: ID!) {
          node(id: $id) {
            ... on Object { to { iri detail { __typename } } }
          }
        }
      `;
      const variables = { id: globalId("Object", localId) };
      assert.deepEqual(await read(graphql, query, variables), {
        node: { to: [{ iri: hiddenIri, detail: null }] },
      });
      assert.deepEqual(await read(graphql, query, variables, admin), {
        node: { to: [{ iri: hiddenIri, detail: { __typename: "Object" } }] },
      });
    });
  });
});
