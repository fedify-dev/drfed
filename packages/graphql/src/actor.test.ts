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

import { type Database, schema } from "@drfed/models";
import { describe, it } from "@logtape/testing-node/autoload";

import { withTestHarness } from "./harness.test.ts";

const accepted = new Date("2026-08-04T00:00:00.000Z");
const created = new Date("2026-08-04T00:00:00.000Z");
const expires = new Date("2030-08-04T00:00:00.000Z");
const ok = 200;

const accountId = "00000000-0000-4000-8000-000000000001";
const localInstanceId = "00000000-0000-4000-8000-000000000101";
const remoteInstanceId = "00000000-0000-4000-8000-000000000102";
const localActorId = "00000000-0000-4000-8000-000000000201";
const remoteActorId = "00000000-0000-4000-8000-000000000202";
const sessionId = "00000000-0000-4000-8000-000000000301";
const accessToken = "test-access-token";

const genActorsMutation = `
  mutation GenActors($instance: ID!, $size: Int!) {
    genActors(instance: $instance, size: $size) {
      resultType: __typename
      ... on CreateActorsSuccess {
        actors {
          username
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
        iri
        handle
        type
        username
        instance {
          uuid
          location
          host
        }
        inboxUrl
        outboxUrl
        avatarUrl
        followersUrl
        followeesUrl
        headerUrl
        profileUrl
        featuredUrl
      }
    }
  }
`;

describe("Mutation.genActors", () => {
  it("creates local actors", async () => {
    await withTestHarness(async ({ db, post }) => {
      const auth = await seedAuthenticatedLocalInstance(db);

      const response = await post(
        {
          query: genActorsMutation,
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
      assert.equal(body.data.genActors.resultType, "CreateActorsSuccess");
      assert.equal(body.data.genActors.actors.length, 2);
      assert.equal(
        body.data.genActors.actors.every(
          ({ username }: { username: unknown }) => typeof username === "string",
        ),
        true,
      );

      const actors = await db.select().from(schema.actors);
      assert.equal(actors.length, 2);
      assert.equal(
        actors.every(
          (actor) =>
            actor.instanceId === localInstanceId &&
            actor.location === "Local" &&
            actor.type === "Person",
        ),
        true,
      );

      const localActors = await db.select().from(schema.localActors);
      assert.equal(localActors.length, 2);
      assert.deepEqual(
        new Set(localActors.map(({ id }) => id)),
        new Set(actors.map(({ id }) => id)),
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
            iri: `https://test-instance.drfed.org/users/${localActorId}`,
            handle: "@alice@test-instance.drfed.org",
            type: "Person",
            username: "alice",
            instance: {
              uuid: localInstanceId,
              location: "Local",
              host: "test-instance.drfed.org",
            },
            inboxUrl: `https://test-instance.drfed.org/users/${localActorId}/inbox`,
            outboxUrl: `https://test-instance.drfed.org/users/${localActorId}/outbox`,
            avatarUrl: `https://test-instance.drfed.org/users/${localActorId}/avatar/avatar.png`,
            followersUrl: `https://test-instance.drfed.org/users/${localActorId}/followers`,
            followeesUrl: `https://test-instance.drfed.org/users/${localActorId}/followees`,
            headerUrl: `https://test-instance.drfed.org/users/${localActorId}/header/header.png`,
            profileUrl: "https://test-instance.drfed.org/@alice",
            featuredUrl: `https://test-instance.drfed.org/users/${localActorId}/featured`,
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
            iri: "https://remote.example.com/users/bob",
            handle: "@bob@remote.example.com",
            type: "Service",
            username: "bob",
            instance: {
              uuid: remoteInstanceId,
              location: "Remote",
              host: "remote.example.com",
            },
            inboxUrl: "https://remote.example.com/users/bob/inbox",
            outboxUrl: "https://remote.example.com/users/bob/outbox",
            avatarUrl: "https://remote.example.com/users/bob/avatar.png",
            followersUrl: "https://remote.example.com/users/bob/followers",
            followeesUrl: "https://remote.example.com/users/bob/followees",
            headerUrl: "https://remote.example.com/users/bob/header.png",
            profileUrl: "https://remote.example.com/@bob",
            featuredUrl: "https://remote.example.com/users/bob/featured",
          },
        },
      });
    });
  });
});

function globalId(type: "Actor" | "Instance", id: string): string {
  return Buffer.from(`${type}:${id}`).toString("base64");
}

async function seedAuthenticatedLocalInstance(
  db: Database,
): Promise<RequestInit> {
  await db.insert(schema.accounts).values({
    id: accountId,
    email: "owner@example.com",
    name: "Owner",
    created,
  });
  await db.insert(schema.sessions).values({
    id: sessionId,
    accountId,
    tokenHash: await hashSecret(accessToken),
  });
  await seedLocalInstance(db);
  await db.insert(schema.instanceMembers).values({
    accountId,
    instanceId: localInstanceId,
    admin: true,
    accepted,
    created,
  });
  return { headers: { authorization: `Bearer ${accessToken}` } };
}

async function seedLocalActor(db: Database): Promise<void> {
  await seedLocalInstance(db);
  await db.insert(schema.actors).values({
    id: localActorId,
    instanceId: localInstanceId,
    location: "Local",
    type: "Person",
    username: "alice",
    created,
  });
  await db.insert(schema.localActors).values({
    id: localActorId,
    avatar: "avatar.png",
    header: "header.png",
  });
}

async function seedLocalInstance(db: Database): Promise<void> {
  await db.insert(schema.instances).values({
    id: localInstanceId,
    location: "Local",
    created,
  });
  await db.insert(schema.localInstances).values({
    id: localInstanceId,
    slug: "test-instance",
    expires,
  });
}

async function seedRemoteActor(db: Database): Promise<void> {
  await db.insert(schema.instances).values({
    id: remoteInstanceId,
    location: "Remote",
    created,
  });
  await db.insert(schema.remoteInstances).values({
    id: remoteInstanceId,
    host: "remote.example.com",
  });
  await db.insert(schema.actors).values({
    id: remoteActorId,
    instanceId: remoteInstanceId,
    location: "Remote",
    type: "Service",
    username: "bob",
    created,
  });
  await db.insert(schema.remoteActors).values({
    id: remoteActorId,
    iriUrl: "https://remote.example.com/users/bob",
    inboxUrl: "https://remote.example.com/users/bob/inbox",
    outboxUrl: "https://remote.example.com/users/bob/outbox",
    avatarUrl: "https://remote.example.com/users/bob/avatar.png",
    followersUrl: "https://remote.example.com/users/bob/followers",
    followeesUrl: "https://remote.example.com/users/bob/followees",
    headerUrl: "https://remote.example.com/users/bob/header.png",
    profileUrl: "https://remote.example.com/@bob",
    featuredUrl: "https://remote.example.com/users/bob/featured",
  });
}

async function hashSecret(raw: string): Promise<string> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
  ).toHex();
}
