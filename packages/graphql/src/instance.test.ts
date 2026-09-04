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

// oxlint-disable no-underscore-dangle
import assert from "node:assert/strict";

import { type Database, schema } from "@drfed/models";
import { describe, it } from "@logtape/testing-node/autoload";
import { DrizzleQueryError } from "drizzle-orm";

import { withTestHarness } from "./harness.test.ts";

const accepted = new Date("2026-06-24T00:00:00.000Z");
const created = new Date("2026-06-24T00:00:00.000Z");
const expires = new Date("2026-07-24T00:00:00.000Z");
const ok = 200;
const defaultMaxActors = 10;

const accountId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const pendingMemberId = "00000000-0000-4000-8000-000000000003";
const instanceId = "00000000-0000-4000-8000-000000000101";
const localInstanceId = "00000000-0000-4000-8000-000000000103";
const duplicateRemoteInstanceId = "00000000-0000-4000-8000-000000000102";
const sessionId = "00000000-0000-4000-8000-000000000201";
const accessToken = "test-access-token";

const remoteInstanceQuery = `
  query RemoteInstance($uuid: UUID!) {
    accountByUuid(uuid: $uuid) {
      instances {
        edges {
          node {
            uuid
            host
          }
        }
      }
    }
  }
`;

const localInstanceQuery = `
  query LocalInstance($uuid: UUID!) {
    accountByUuid(uuid: $uuid) {
      instances {
        edges {
          node {
            host
            localInstance {
              uuid
              slug
              expires
              maxActors
            }
          }
        }
      }
    }
  }
`;

const localInstanceBySlugQuery = `
  query LocalInstanceBySlug($slug: String!) {
    localInstanceBySlug(slug: $slug) {
      uuid
      slug
      expires
      maxActors
      instance {
        uuid
        host
      }
    }
  }
`;

const instanceMembersQuery = `
  query InstanceMembers($uuid: UUID!) {
    accountByUuid(uuid: $uuid) {
      instances {
        edges {
          node {
            members {
              totalCount
              edges {
                created
                accepted
                admin
                node {
                  uuid
                  email
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

const instanceMembersResponse = {
  data: {
    accountByUuid: {
      instances: {
        edges: [
          {
            node: {
              members: {
                totalCount: 2,
                edges: [
                  {
                    created: "2026-06-24T00:00:00.000Z",
                    accepted: "2026-06-24T00:00:00.000Z",
                    admin: true,
                    node: {
                      uuid: accountId,
                      email: "owner@example.com",
                      name: "Owner",
                    },
                  },
                  {
                    created: "2026-06-24T00:00:00.000Z",
                    accepted: "2026-06-24T00:00:00.000Z",
                    admin: false,
                    node: {
                      uuid: memberId,
                      email: "member@example.com",
                      name: "Member",
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    },
  },
};

describe("Instance.members", () => {
  it("returns the instance's accepted members", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedInstanceMembers(db);

      const response = await post({
        query: instanceMembersQuery,
        variables: { uuid: accountId },
      });

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), instanceMembersResponse);
    });
  });
});

const createInstanceMutation = `
  mutation CreateInstance($slug: String!) {
    createInstance(slug: $slug) {
      __typename
      ... on Instance {
        uuid
        host
      }
      ... on CreateInstanceError {
        type
        message
      }
    }
  }
`;

describe("Mutation.createInstance", () => {
  it("creates an instance and adds the viewer as a member", async () => {
    await withTestHarness(async ({ db, post }) => {
      const auth = await authenticate(db);

      const response = await post(
        { query: createInstanceMutation, variables: { slug: "my-instance" } },
        auth,
      );

      assert.equal(response.status, ok);
      const body = await response.json();
      assert.equal(body.errors, undefined);
      assert.equal(body.data.createInstance.__typename, "Instance");
      assert.equal(body.data.createInstance.host, "my-instance.drfed.org");
      assert.equal(typeof body.data.createInstance.uuid, "string");

      const instances = await db.select().from(schema.instances);
      assert.equal(instances.length, 1);
      const instance = instances[0]!;
      assert.equal(typeof instance.localId, "string");
      const local = await db.query.localInstances.findFirst({
        where: { id: instance.localId! },
      });
      assert.equal(local?.slug, "my-instance");

      const members = await db.select().from(schema.instanceMembers);
      assert.equal(members.length, 1);
      assert.equal(members[0]?.accountId, accountId);
      assert.equal(members[0]?.instanceId, instances[0]?.id);
      assert.ok(members[0]?.accepted instanceof Date);
    });
  });

  it("fails when the viewer reaches the maximum number of instances", async () => {
    await withTestHarness(async ({ db, post }) => {
      const auth = await authenticate(db, 1);

      const first = await post(
        {
          query: createInstanceMutation,
          variables: { slug: "first-instance" },
        },
        auth,
      );
      assert.equal(first.status, ok);
      assert.equal(
        (await first.json()).data.createInstance.__typename,
        "Instance",
      );

      const second = await post(
        {
          query: createInstanceMutation,
          variables: { slug: "second-instance" },
        },
        auth,
      );
      assert.equal(second.status, ok);
      const body = await second.json();
      assert.equal(body.errors, undefined);
      assert.equal(body.data.createInstance.__typename, "CreateInstanceError");
      assert.equal(body.data.createInstance.type, "TooManyInstances");

      // The failed creation is rolled back, so only the first instance remains.
      const instances = await db.select().from(schema.instances);
      assert.equal(instances.length, 1);
    });
  });

  it("fails when the slug is already taken", async () => {
    await withTestHarness(async ({ db, post }) => {
      const auth = await authenticate(db);

      const first = await post(
        { query: createInstanceMutation, variables: { slug: "taken-slug" } },
        auth,
      );
      assert.equal(first.status, ok);
      assert.equal(
        (await first.json()).data.createInstance.__typename,
        "Instance",
      );

      const second = await post(
        { query: createInstanceMutation, variables: { slug: "taken-slug" } },
        auth,
      );
      assert.equal(second.status, ok);
      const body = await second.json();
      assert.equal(body.errors, undefined);
      assert.equal(body.data.createInstance.__typename, "CreateInstanceError");
      assert.equal(body.data.createInstance.type, "SlugAlreadyTaken");

      const instances = await db.select().from(schema.instances);
      assert.equal(instances.length, 1);
    });
  });
});

describe("Instance.localInstance", () => {
  it("returns the `LocalInstance` backing a local `Instance`", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedInstanceMembers(db);

      const response = await post({
        query: localInstanceQuery,
        variables: { uuid: accountId },
      });

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), {
        data: {
          accountByUuid: {
            instances: {
              edges: [
                {
                  node: {
                    host: "test-instance.drfed.org",
                    localInstance: {
                      uuid: localInstanceId,
                      slug: "test-instance",
                      expires: expires.toISOString(),
                      maxActors: defaultMaxActors,
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

  it("returns null for a remote `Instance`", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedRemoteInstance(db);

      const response = await post({
        query: localInstanceQuery,
        variables: { uuid: accountId },
      });

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), {
        data: {
          accountByUuid: {
            instances: {
              edges: [
                {
                  node: {
                    host: "remote.example.com",
                    localInstance: null,
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

describe("Query.localInstanceBySlug", () => {
  it("returns the `LocalInstance` with the given slug", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedInstanceMembers(db);
      const auth = await createSession(db);

      const response = await post(
        {
          query: localInstanceBySlugQuery,
          variables: { slug: "test-instance" },
        },
        auth,
      );

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), {
        data: {
          localInstanceBySlug: {
            uuid: localInstanceId,
            slug: "test-instance",
            expires: expires.toISOString(),
            maxActors: defaultMaxActors,
            instance: {
              uuid: instanceId,
              host: "test-instance.drfed.org",
            },
          },
        },
      });
    });
  });

  it("returns null when no `LocalInstance` has the slug", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedInstanceMembers(db);
      const auth = await createSession(db);

      const response = await post(
        {
          query: localInstanceBySlugQuery,
          variables: { slug: "no-such-instance" },
        },
        auth,
      );

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), {
        data: { localInstanceBySlug: null },
      });
    });
  });

  it("denies the field to an unauthenticated viewer", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedInstanceMembers(db);

      const response = await post({
        query: localInstanceBySlugQuery,
        variables: { slug: "test-instance" },
      });

      assert.equal(response.status, ok);
      const body = await response.json();
      assert.equal(body.data.localInstanceBySlug, null);
      assert.equal(body.errors.length, 1);
      assert.equal(
        body.errors[0].message,
        "Not authorized to resolve Query.localInstanceBySlug",
      );
      assert.deepEqual(body.errors[0].path, ["localInstanceBySlug"]);
    });
  });
});

describe("Remote instance", () => {
  it("returns a created remote instance", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedRemoteInstance(db);

      const response = await post({
        query: remoteInstanceQuery,
        variables: { uuid: accountId },
      });

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), {
        data: {
          accountByUuid: {
            instances: {
              edges: [
                {
                  node: {
                    uuid: instanceId,
                    host: "remote.example.com",
                  },
                },
              ],
            },
          },
        },
      });
    });
  });

  it("requires a unique host", async () => {
    await withTestHarness(async ({ db }) => {
      await seedRemoteInstance(db);

      await assert.rejects(
        db.insert(schema.instances).values({
          id: duplicateRemoteInstanceId,
          host: "remote.example.com",
        }),
        (error: unknown) =>
          error instanceof DrizzleQueryError &&
          error.cause != null &&
          "constraint" in error.cause &&
          error.cause.constraint === "instances_host_key",
      );
    });
  });
});

/**
 * Seeds an account and an authenticated session, then returns the request
 * options carrying the session's bearer token.
 *
 * @param db The database to seed.
 * @param maxInstances The account's instance quota.  Omit to use the schema
 *                     default.
 * @returns Request options with an `Authorization` header for {@link post}.
 */
async function authenticate(
  db: Database,
  maxInstances?: number,
): Promise<RequestInit> {
  await db.insert(schema.accounts).values({
    id: accountId,
    email: "owner@example.com",
    name: "Owner",
    ...(maxInstances == null ? {} : { maxInstances }),
    created,
  });
  return createSession(db);
}

/**
 * Opens an authenticated session for the account seeded as {@link accountId},
 * then returns the request options carrying the session's bearer token.  Use
 * this instead of {@link authenticate} when the account already exists, e.g.
 * after {@link seedInstanceMembers}.
 *
 * @param db The database to seed.
 * @returns Request options with an `Authorization` header for {@link post}.
 */
async function createSession(db: Database): Promise<RequestInit> {
  await db.insert(schema.sessions).values({
    id: sessionId,
    accountId,
    tokenHash: await hashSecret(accessToken),
  });
  return { headers: { authorization: `Bearer ${accessToken}` } };
}

/**
 * Computes the SHA-256 hex digest the server stores for a bearer token,
 * mirroring `hashSecret` in *auth/hash.ts*.
 *
 * @param raw The raw access token.
 * @returns The lowercase hex-encoded SHA-256 digest.
 */
async function hashSecret(raw: string): Promise<string> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
  ).toHex();
}

async function seedInstanceMembers(db: Database): Promise<void> {
  await db.insert(schema.accounts).values([
    {
      id: accountId,
      email: "owner@example.com",
      name: "Owner",
      admin: false,
      created,
    },
    {
      id: memberId,
      email: "member@example.com",
      name: "Member",
      admin: false,
      created,
    },
    {
      id: pendingMemberId,
      email: "pending@example.com",
      name: "Pending",
      admin: false,
      created,
    },
  ]);
  await db.insert(schema.localInstances).values({
    id: localInstanceId,
    slug: "test-instance",
    expires,
  });
  await db.insert(schema.instances).values({
    id: instanceId,
    localId: localInstanceId,
    created,
    host: "test-instance.drfed.org",
  });
  await db.insert(schema.instanceMembers).values([
    {
      accountId,
      instanceId,
      admin: true,
      accepted,
      created,
    },
    {
      accountId: memberId,
      instanceId,
      admin: false,
      accepted,
      created,
    },
    {
      accountId: pendingMemberId,
      instanceId,
      admin: false,
      accepted: null,
      created,
    },
  ]);
}

async function seedRemoteInstance(db: Database): Promise<void> {
  await db.insert(schema.accounts).values({
    id: accountId,
    email: "owner@example.com",
    name: "Owner",
    created,
  });
  await db.insert(schema.instances).values({
    id: instanceId,
    created,
    host: "remote.example.com",
  });
  await db.insert(schema.instanceMembers).values({
    accountId,
    instanceId,
    accepted,
    created,
  });
}
