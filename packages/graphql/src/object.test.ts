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

// oxlint-disable max-statements
// Sequential mutations exercise counter updates in the same database.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";

import { schema } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import { uuidV7 as uuid } from "@drfed/models/uuid";
import { describe, it } from "@logtape/testing-node/autoload";
import { eq } from "drizzle-orm";

import { withTestHarness } from "./harness.test.ts";
import {
  globalId,
  localActorId,
  remoteActorId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedObjects,
  seedRemoteActor,
} from "./seed.test.ts";

const fields = `id uuid iri url type actor { uuid } to { target { iri kind } } cc { target { iri } } name summary contentHtml language sensitive published updated created`;
const mutation = `mutation Create($actor: ID!, $contentHtml: String!, $language: String, $type: ObjectType! = Note, $addressing: AddressingInput!) {
  createObject(actor: $actor, contentHtml: $contentHtml, language: $language, type: $type, addressing: $addressing) {
    resultType: __typename
    ... on Object { ${fields} }
    ... on CreateObjectError { errorType: type message }
  }
}`;
const variables = {
  actor: globalId("Actor", localActorId),
  contentHtml: "<p>Hello</p>",
  addressing: { to: [PUBLIC_IRI] },
};

describe("Mutation.createObject", () => {
  it("creates verbatim HTML, canonicalizes language and resolves every node field", async () => {
    await withTestHarness(async ({ db, post }) => {
      const auth = await seedAuthenticatedLocalInstance(db);
      await seedLocalActor(db);
      const contentHtml = '<p onclick="debug()">Hello</p>';
      const response = await post(
        {
          query: mutation,
          variables: { ...variables, contentHtml, language: "KO-kr" },
        },
        auth,
      );
      const body = await response.json();
      assert.equal(body.errors, undefined);
      const object = body.data.createObject;
      assert.equal(object.resultType, "Object");
      assert.equal(object.type, "Note");
      assert.deepEqual(object.to, [
        { target: { iri: PUBLIC_IRI, kind: "collection" } },
      ]);
      assert.equal(object.language, "ko-KR");
      assert.equal(object.contentHtml, contentHtml);
      assert.equal(
        object.iri,
        `https://test-instance.drfed.org/users/${localActorId}/${object.uuid}`,
      );
      assert.equal(object.sensitive, false);
      assert.equal(object.url, null);
      assert.deepEqual(object.actor, { uuid: localActorId });
      const row = await db.query.objects.findFirst({
        where: { id: object.uuid },
      });
      assert.equal(row?.contentHtml, contentHtml);
      assert.equal(row?.language, "ko-KR");
      assert.equal(
        (await db.query.actors.findFirst({ where: { id: localActorId } }))
          ?.postsCount,
        1,
      );
      const node = await post({
        query: `query($id: ID!) { node(id: $id) { resultType: __typename ... on Object { ${fields} } } }`,
        variables: { id: object.id },
      });
      assert.deepEqual(await node.json(), { data: { node: object } });
    });
  });
  for (const [input, error] of [
    [{ contentHtml: " \n\t" }, "InvalidContent"],
    [{ language: "not_a_tag" }, "InvalidLanguage"],
    [{ language: "" }, "InvalidLanguage"],
    [
      { language: "en-x-abcdefgh-abcdefgh-abcdefgh-abcdefgh" },
      "InvalidLanguage",
    ],
  ] as const) {
    it(`rejects invalid input ${JSON.stringify(input)}`, async () => {
      await withTestHarness(async ({ db, post }) => {
        const auth = await seedAuthenticatedLocalInstance(db);
        await seedLocalActor(db);
        const body = await (
          await post(
            { query: mutation, variables: { ...variables, ...input } },
            auth,
          )
        ).json();
        assert.equal(body.errors, undefined);
        assert.equal(body.data.createObject.errorType, error);
        assert.equal(await db.$count(schema.objects), 0);
      });
    });
  }
  for (const scenario of [
    "remote",
    "nonmember",
    "pending",
    "expired",
    "deleted",
    "missing",
    "malformed",
  ] as const) {
    it(`hides ${scenario} actors`, async () => {
      await withTestHarness(async ({ db, post }) => {
        const auth = await seedAuthenticatedLocalInstance(db);
        await seedLocalActor(db);
        await seedRemoteActor(db);
        if (scenario === "nonmember") await db.delete(schema.instanceMembers);
        if (scenario === "pending") {
          await db.update(schema.instanceMembers).set({ accepted: null });
        }
        if (scenario === "expired") {
          await db
            .update(schema.localInstances)
            .set({ expires: Temporal.Instant.fromEpochMilliseconds(0) });
        }
        if (scenario === "deleted") {
          await db
            .update(schema.actors)
            .set({ deleted: Temporal.Now.instant() })
            .where(eq(schema.actors.id, localActorId));
        }
        const actorId =
          scenario === "remote"
            ? remoteActorId
            : scenario === "missing"
              ? uuid()
              : scenario === "malformed"
                ? "bad"
                : localActorId;
        const body = await (
          await post(
            {
              query: mutation,
              variables: { ...variables, actor: globalId("Actor", actorId) },
            },
            auth,
          )
        ).json();
        assert.equal(body.errors, undefined);
        assert.equal(body.data.createObject.errorType, "ActorNotFound");
        assert.equal(await db.$count(schema.objects), 0);
      });
    });
  }
  for (const text of ["", " \n\t", "  Keep spacing  "]) {
    it(`normalizes optional text ${JSON.stringify(text)}`, async () => {
      await withTestHarness(async ({ db, post }) => {
        const auth = await seedAuthenticatedLocalInstance(db);
        await seedLocalActor(db);
        const query = mutation.replace(
          "type: $type,",
          `name: ${JSON.stringify(text)}, summary: ${JSON.stringify(text)}, type: $type,`,
        );
        const body = await (await post({ query, variables }, auth)).json();
        assert.equal(body.errors, undefined);
        const expected = text.trim() === "" ? null : text;
        assert.equal(body.data.createObject.name, expected);
        assert.equal(body.data.createObject.summary, expected);
        const row = await db.query.objects.findFirst();
        assert.equal(row?.name, expected);
        assert.equal(row?.summary, expected);
      });
    });
  }
  it("requires authentication", async () => {
    await withTestHarness(async ({ post }) => {
      const body = await (await post({ query: mutation, variables })).json();
      assert.ok(body.errors?.length);
    });
  });
  it("creates Articles with optional fields and varied addressing on a suspended actor", async () => {
    await withTestHarness(async ({ db, post }) => {
      const auth = await seedAuthenticatedLocalInstance(db);
      await seedLocalActor(db);
      await db
        .update(schema.actors)
        .set({ suspended: Temporal.Instant.fromEpochMilliseconds(0) })
        .where(eq(schema.actors.id, localActorId));
      for (const addressing of [
        { to: [PUBLIC_IRI] },
        { cc: [PUBLIC_IRI] },
        {},
      ]) {
        const query = mutation.replace(
          "type: $type,",
          'name: "Title", summary: "CW", sensitive: true, type: $type,',
        );
        const body = await (
          await post(
            { query, variables: { ...variables, type: "Article", addressing } },
            auth,
          )
        ).json();
        assert.equal(body.errors, undefined);
        assert.equal(body.data.createObject.type, "Article");

        assert.equal(body.data.createObject.name, "Title");
        assert.equal(body.data.createObject.summary, "CW");
        assert.equal(body.data.createObject.sensitive, true);
      }
      assert.equal(
        (await db.query.actors.findFirst({ where: { id: localActorId } }))
          ?.postsCount,
        3,
      );
    });
  });
});

describe("Actor.objects", () => {
  it("keeps followers objects publicly readable through GraphQL", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);
      const id = uuid();
      await seedObjects(db, {
        id,
        actorId: localActorId,
        type: "Note",
        addressing: {
          to: [
            `https://test-instance.drfed.org/users/${localActorId}/followers`,
          ],
        },
        iri: `https://test-instance.drfed.org/users/${localActorId}/${id}`,
        contentHtml: "GraphQL debugging content",
      });
      const query = `query($object: ID!, $actor: ID!) {
        node(id: $object) { ... on Object { uuid contentHtml } }
        nodes(ids: [$object]) { ... on Object { uuid } }
        actor: node(id: $actor) { ... on Actor { objects(first: 1) { totalCount edges { node { uuid } } } } }
      }`;
      const body = await (
        await post({
          query,
          variables: {
            object: globalId("Object", id),
            actor: globalId("Actor", localActorId),
          },
        })
      ).json();
      assert.deepEqual(body, {
        data: {
          node: {
            uuid: id,
            contentHtml: "GraphQL debugging content",
          },
          nodes: [{ uuid: id }],
          actor: {
            objects: { totalCount: 1, edges: [{ node: { uuid: id } }] },
          },
        },
      });
    });
  });

  it("paginates by published time and UUID, excluding deleted and other actors", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);
      await seedRemoteActor(db);
      const ids = Array.from({ length: 5 }, () => uuid());
      await seedObjects(
        db,
        ids.map((id, index) => ({
          id,
          actorId: index === 4 ? remoteActorId : localActorId,
          type: "Note" as const,
          iri: `https://test.example/${id}`,
          contentHtml: "test",
          published: Temporal.Instant.from(
            index === 0 ? "2027-01-01T00:00:00Z" : "2026-01-01T00:00:00Z",
          ),
          deleted: index === 3 ? Temporal.Now.instant() : null,
        })),
      );
      const query = `query($actor: ID!, $after: String, $before: String, $first: Int, $last: Int) { node(id: $actor) { ... on Actor { objects(first: $first, after: $after, last: $last, before: $before) { totalCount edges { cursor node { uuid } } pageInfo { hasNextPage hasPreviousPage } } } } }`;
      const first = await (
        await post({
          query,
          variables: { actor: globalId("Actor", localActorId), first: 2 },
        })
      ).json();
      assert.equal(first.errors, undefined);
      const connection = first.data.node.objects;
      assert.equal(connection.totalCount, 3);
      assert.deepEqual(
        connection.edges.map(
          (edge: { node: { uuid: string } }) => edge.node.uuid,
        ),
        [ids[0], ids[2]],
      );
      assert.equal(connection.pageInfo.hasNextPage, true);
      const next = await (
        await post({
          query,
          variables: {
            actor: globalId("Actor", localActorId),
            first: 2,
            after: connection.edges[1].cursor,
          },
        })
      ).json();
      assert.equal(next.errors, undefined);
      assert.deepEqual(
        next.data.node.objects.edges.map(
          (edge: { node: { uuid: string } }) => edge.node.uuid,
        ),
        [ids[1]],
      );
      assert.equal(next.data.node.objects.pageInfo.hasNextPage, false);
      const previous = await (
        await post({
          query,
          variables: {
            actor: globalId("Actor", localActorId),
            last: 2,
            before: next.data.node.objects.edges[0].cursor,
          },
        })
      ).json();
      assert.equal(previous.errors, undefined);
      assert.deepEqual(previous.data.node.objects.edges, connection.edges);
    });
  });
});

describe("Query.node", () => {
  it("hides deleted objects from node and nodes while keeping live ones", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);
      const liveId = uuid();
      const deletedId = uuid();
      await seedObjects(
        db,
        [liveId, deletedId].map((id) => ({
          id,
          actorId: localActorId,
          type: "Note" as const,
          iri: `https://test-instance.drfed.org/users/${localActorId}/${id}`,
          contentHtml: "test",
          deleted: id === deletedId ? Temporal.Now.instant() : null,
        })),
      );
      const query = `query($live: ID!, $deleted: ID!) {
        live: node(id: $live) { ... on Object { uuid actor { uuid } } }
        deleted: node(id: $deleted) { ... on Object { uuid actor { uuid } } }
        nodes(ids: [$live, $deleted]) { ... on Object { uuid } }
      }`;
      const body = await (
        await post({
          query,
          variables: {
            live: globalId("Object", liveId),
            deleted: globalId("Object", deletedId),
          },
        })
      ).json();
      assert.deepEqual(body, {
        data: {
          live: { uuid: liveId, actor: { uuid: localActorId } },
          deleted: null,
          nodes: [{ uuid: liveId }, null],
        },
      });
    });
  });
});

// Regression test for
// https://github.com/fedify-dev/drfed/pull/73#discussion_r4005163244:
// Preserve microseconds through the database, GraphQL scalar and cursor.
describe("Actor.objects cursor precision", () => {
  it("returns every object whose published time carries microseconds", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);
      const ids = Array.from({ length: 3 }, () => uuid());
      await seedObjects(
        db,
        ids.map((id) => ({
          id,
          actorId: localActorId,
          type: "Note" as const,
          iri: `https://test-instance.drfed.org/users/${localActorId}/${id}`,
          contentHtml: "test",
          published: Temporal.Instant.from("2026-09-14T12:00:00.123456Z"),
        })),
      );
      const query = `query($actor: ID!, $after: String) { node(id: $actor) { ... on Actor { objects(first: 1, after: $after) { edges { cursor node { uuid published } } pageInfo { hasNextPage } } } } }`;
      const seen: string[] = [];
      let after: string | null = null;
      let hasNextPage = true;
      for (let page = 0; hasNextPage && page <= ids.length; page += 1) {
        const body = await (
          await post({
            query,
            variables: { actor: globalId("Actor", localActorId), after },
          })
        ).json();
        assert.equal(body.errors, undefined);
        const connection = body.data.node.objects;
        assert.equal(connection.edges.length, 1);
        assert.equal(
          connection.edges[0].node.published,
          "2026-09-14T12:00:00.123456Z",
        );
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

// Regression test for
// https://github.com/fedify-dev/drfed/pull/73#discussion_r4005163257:
// `filterDeleted` only inspects the node's own `deleted` column, so objects of
// a soft-deleted actor still resolve and `Object.actor` returns that actor.
describe("Query.node with a deleted actor", () => {
  it("hides the objects of a deleted actor from node, nodes, and Object.actor", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);
      await seedRemoteActor(db);
      const hiddenId = uuid();
      const liveId = uuid();
      await seedObjects(
        db,
        [hiddenId, liveId].map((id) => ({
          id,
          actorId: id === hiddenId ? localActorId : remoteActorId,
          type: "Note" as const,
          iri: `https://test.example/${id}`,
          contentHtml: "test",
        })),
      );
      await db
        .update(schema.actors)
        .set({ deleted: Temporal.Now.instant() })
        .where(eq(schema.actors.id, localActorId));
      const query = `query($hidden: ID!, $live: ID!) {
        hidden: node(id: $hidden) { ... on Object { uuid actor { uuid } } }
        live: node(id: $live) { ... on Object { uuid actor { uuid } } }
        nodes(ids: [$hidden, $live]) { ... on Object { uuid } }
      }`;
      const body = await (
        await post({
          query,
          variables: {
            hidden: globalId("Object", hiddenId),
            live: globalId("Object", liveId),
          },
        })
      ).json();
      assert.deepEqual(body, {
        data: {
          hidden: null,
          live: { uuid: liveId, actor: { uuid: remoteActorId } },
          nodes: [null, { uuid: liveId }],
        },
      });
    });
  });
});

describe("explicit addressing and persisted activities", () => {
  it("preserves exact IRI order, duplicates, all properties and JSON-LD snapshots", async () => {
    await withTestHarness(async ({ db, post, federation }) => {
      const auth = await seedAuthenticatedLocalInstance(db);
      await seedLocalActor(db);
      const unknown = "https://REMOTE.example:443/a/../target";
      const blind = "https://remote.example/blind";
      const addressing = {
        to: [unknown, PUBLIC_IRI, unknown],
        cc: [unknown],
        bto: [blind],
        bcc: [blind],
        audience: [unknown, unknown],
      };
      const query = mutation.replace(
        "... on Object {",
        "... on Object { document bto { target { iri } } bcc { target { iri } } audience { target { iri } } createActivity { id iri document type actor { uuid } object { iri kind ... on Object { contentHtml } } to { target { iri } } bto { target { iri } } }",
      );
      const create = async () => {
        const body = await (
          await post({ query, variables: { ...variables, addressing } }, auth)
        ).json();
        assert.equal(body.errors, undefined);
        return body.data.createObject;
      };
      const object = await create();
      await create();
      assert.deepEqual(
        object.to.map((r: { target: { iri: string } }) => r.target.iri),
        addressing.to,
      );
      assert.equal(object.to[0].target.kind, "unknown");
      assert.deepEqual(
        object.audience.map((r: { target: { iri: string } }) => r.target.iri),
        addressing.audience,
      );
      assert.deepEqual(object.bto, [{ target: { iri: blind } }]);
      assert.deepEqual(object.bcc, object.bto);
      assert.equal(object.createActivity.type, "Create");
      assert.equal(object.createActivity.object.iri, object.iri);
      assert.equal(object.createActivity.object.kind, "object");
      assert.equal(
        object.createActivity.object.contentHtml,
        variables.contentHtml,
      );
      assert.deepEqual(object.createActivity.actor, { uuid: localActorId });
      for (const document of [
        object.document,
        object.createActivity.document,
      ]) {
        for (const [property, values] of Object.entries(addressing)) {
          assert.deepEqual(document[property], values);
        }
      }
      assert.equal(
        await db.$count(schema.resources, eq(schema.resources.iri, unknown)),
        1,
      );
      const activity = await db.query.activities.findFirst({
        where: { objectId: object.uuid },
        with: { resource: true },
      });
      assert.ok(activity);
      assert.notEqual(activity.id, object.uuid);
      assert.ok(activity.resource.iri.endsWith(`/ap/creates/${activity.id}`));
      const stored = await db.query.objects.findFirst({
        where: { id: object.uuid },
      });
      assert.deepEqual(stored?.document, object.document);
      assert.deepEqual(activity.document, object.createActivity.document);
      for (const iri of [object.iri, activity.resource.iri]) {
        const response = await federation.fetch(
          new Request(iri, {
            headers: { accept: "application/activity+json" },
          }),
          { contextData: undefined },
        );
        assert.equal(response.status, 200);
        const document = await response.json();
        assert.equal(document.bto, undefined);
        assert.equal(document.bcc, undefined);
        assert.equal(document.id, iri);
      }
    });
  });
  it("accepts empty addressing but requires the input argument", async () => {
    await withTestHarness(async ({ db, post, federation }) => {
      const auth = await seedAuthenticatedLocalInstance(db);
      await seedLocalActor(db);
      const missing = await (
        await post(
          {
            query: mutation,
            variables: {
              actor: variables.actor,
              contentHtml: variables.contentHtml,
            },
          },
          auth,
        )
      ).json();
      assert.ok(missing.errors?.length);
      const body = await (
        await post(
          { query: mutation, variables: { ...variables, addressing: {} } },
          auth,
        )
      ).json();
      assert.equal(body.errors, undefined);
      assert.deepEqual(body.data.createObject.to, []);
      assert.equal(await db.$count(schema.addressing), 0);
      assert.equal(await db.$count(schema.activities), 1);
      const response = await federation.fetch(
        new Request(body.data.createObject.iri, {
          headers: { accept: "application/activity+json" },
        }),
        { contextData: undefined },
      );
      assert.equal(response.status, 404);
    });
  });
  it("computes different expected classifications for followers only in cc", async () => {
    await withTestHarness(async ({ db, post }) => {
      const auth = await seedAuthenticatedLocalInstance(db);
      await seedLocalActor(db);
      const body = await (
        await post(
          {
            query: mutation.replace(
              "... on Object {",
              "... on Object { expectedClassifications { implementation version classification reason }",
            ),
            variables: {
              ...variables,
              addressing: {
                cc: [
                  `https://test-instance.drfed.org/users/${localActorId}/followers`,
                ],
              },
            },
          },
          auth,
        )
      ).json();
      assert.equal(body.errors, undefined);
      const results = body.data.createObject.expectedClassifications;
      assert.deepEqual(
        results.map((r: { implementation: string; classification: string }) => [
          r.implementation,
          r.classification,
        ]),
        [
          ["MASTODON", "direct"],
          ["MISSKEY", "followers"],
        ],
      );
      for (const result of results) {
        assert.match(result.version, /^[0-9a-f]{40}$/u);
        assert.match(result.reason, /Expected/u);
      }
    });
  });
});
