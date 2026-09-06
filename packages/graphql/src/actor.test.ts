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

import assert from "node:assert/strict";

import { schema } from "@drfed/models";
import { describe, it } from "@logtape/testing-node/autoload";

import { withTestHarness } from "./harness.test.ts";
import {
  created,
  globalId,
  localActorId,
  localInstanceId,
  ok,
  remoteActorId,
  remoteInstanceId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
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
        outboxUrl
        avatarUrl
        followersUrl
        followingUrl
        headerUrl
        profileUrl
        featuredUrl
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
            outboxUrl: `https://test-instance.drfed.org/users/${localActorId}/outbox`,
            avatarUrl: `https://test-instance.drfed.org/users/${localActorId}/avatar/avatar.png`,
            followersUrl: `https://test-instance.drfed.org/users/${localActorId}/followers`,
            followingUrl: `https://test-instance.drfed.org/users/${localActorId}/following`,
            headerUrl: `https://test-instance.drfed.org/users/${localActorId}/header/header.png`,
            profileUrl: "https://test-instance.drfed.org/@alice",
            featuredUrl: `https://test-instance.drfed.org/users/${localActorId}/featured`,
            created: created.toISOString(),
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
            outboxUrl: "https://remote.example.com/users/bob/outbox",
            avatarUrl: "https://remote.example.com/users/bob/avatar.png",
            followersUrl: "https://remote.example.com/users/bob/followers",
            followingUrl: "https://remote.example.com/users/bob/following",
            headerUrl: "https://remote.example.com/users/bob/header.png",
            profileUrl: "https://remote.example.com/@bob",
            featuredUrl: "https://remote.example.com/users/bob/featured",
            created: created.toISOString(),
          },
        },
      });
    });
  });
});
