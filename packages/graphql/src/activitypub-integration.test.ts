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
import { schema } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import { describe, it } from "@logtape/testing-node/autoload";
import { eq } from "drizzle-orm";

import { withTestHarness } from "./harness.test.ts";
import {
  globalId,
  localActorId,
  remoteActorId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedRemoteActor,
} from "./seed.test.ts";

describe("createYogaServer()", () => {
  it("does not mutate the federation instance", async () => {
    await withTestHarness(({ db, mailer, federation }) => {
      assert.doesNotThrow(() =>
        createYogaServer(db, federation, {
          mailer,
          loginOrigins: new Set(["https://drfed.test"]),
          rootOrigin: new URL("https://drfed.test"),
        }),
      );
    });
  });
});

const actorIri = `https://test-instance.drfed.org/users/${localActorId}`;
const accept = { accept: "application/activity+json" };

const createMutation = `mutation Create($actor: ID!, $addressing: AddressingInput!) {
  createObject(actor: $actor, contentHtml: "<p>Hello</p>", addressing: $addressing) {
    ... on Object { uuid }
    ... on CreateObjectError { errorType: type message }
  }
}`;

// Regression tests for
// https://github.com/fedify-dev/drfed/pull/73#discussion_r4005163252:
// The outbox counter must match its page predicate rather than a stored count.
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

describe("stored collection membership", () => {
  it("reads collection_items for GraphQL items", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedLocalActor(db);
      await seedRemoteActor(db);
      const reference = await db.query.actorCollectionReferences.findFirst({
        where: { actorId: localActorId, role: "followers" },
      });
      assert.ok(reference);
      await db.insert(schema.collectionItems).values({
        collectionId: reference.collectionId,
        itemId: remoteActorId,
        position: 0,
      });
      const body = await (
        await post({
          query: `query($id: ID!) { node(id: $id) { ... on Actor { followers { resource { kind } totalCount items(first: 1) { edges { cursor node { kind iri detail { ... on Actor { username } } } } pageInfo { hasNextPage } } } } } }`,
          variables: { id: globalId("Actor", localActorId) },
        })
      ).json();
      assert.equal(body.errors, undefined);
      assert.equal(body.data.node.followers.totalCount, 1);
      assert.deepEqual(body.data.node.followers.items.edges[0].node, {
        kind: "actor",
        iri: "https://remote.example.com/users/bob",
        detail: { username: "bob" },
      });
    });
  });
});
