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
import { describe, it } from "@logtape/testing-node/autoload";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";

import { withTestHarness } from "./harness.test.ts";
import {
  globalId,
  localActorId,
  remoteActorId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedRemoteActor,
} from "./seed.test.ts";

const fields = `id uuid iri url type actor { uuid } visibility name summary contentHtml language sensitive published updated created`;
const mutation = `mutation Create($actor: ID!, $contentHtml: String!, $language: String, $type: ObjectType! = Note, $visibility: ObjectVisibility! = PUBLIC) {
  createObject(actor: $actor, contentHtml: $contentHtml, language: $language, type: $type, visibility: $visibility) {
    resultType: __typename
    ... on Object { ${fields} }
    ... on CreateObjectError { errorType: type message }
  }
}`;
const variables = {
  actor: globalId("Actor", localActorId),
  contentHtml: "<p>Hello</p>",
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
      assert.equal(object.visibility, "PUBLIC");
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
          await db.update(schema.localInstances).set({ expires: new Date(0) });
        }
        if (scenario === "deleted") {
          await db
            .update(schema.actors)
            .set({ deleted: new Date() })
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
  it("creates Articles with optional fields and all visibilities on a suspended actor", async () => {
    await withTestHarness(async ({ db, post }) => {
      const auth = await seedAuthenticatedLocalInstance(db);
      await seedLocalActor(db);
      await db
        .update(schema.actors)
        .set({ suspended: new Date(0) })
        .where(eq(schema.actors.id, localActorId));
      for (const visibility of ["PUBLIC", "UNLISTED", "FOLLOWERS"]) {
        const query = mutation.replace(
          "type: $type,",
          'name: "Title", summary: "CW", sensitive: true, type: $type,',
        );
        const body = await (
          await post(
            { query, variables: { ...variables, type: "Article", visibility } },
            auth,
          )
        ).json();
        assert.equal(body.errors, undefined);
        assert.equal(body.data.createObject.type, "Article");
        assert.equal(body.data.createObject.visibility, visibility);
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
      await db.insert(schema.objects).values({
        id,
        actorId: localActorId,
        type: "Note",
        visibility: "followers",
        iri: `https://test-instance.drfed.org/users/${localActorId}/${id}`,
        contentHtml: "GraphQL debugging content",
      });
      const query = `query($object: ID!, $actor: ID!) {
        node(id: $object) { ... on Object { uuid visibility contentHtml } }
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
            visibility: "FOLLOWERS",
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
      await db.insert(schema.objects).values(
        ids.map((id, index) => ({
          id,
          actorId: index === 4 ? remoteActorId : localActorId,
          type: "Note" as const,
          iri: `https://test.example/${id}`,
          contentHtml: "test",
          published: new Date(index === 0 ? "2027-01-01" : "2026-01-01"),
          deleted: index === 3 ? new Date() : null,
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
