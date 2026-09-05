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
import assert from "node:assert/strict";

import { type Database, schema } from "@drfed/models";
import { describe, it } from "@logtape/testing-node/autoload";

import { withTestHarness } from "./harness.test.ts";

const accepted = new Date("2026-06-24T00:00:00.000Z");
const created = new Date("2026-06-24T00:00:00.000Z");
const expires = new Date("2026-07-24T00:00:00.000Z");
const ok = 200;

const accountId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const pendingMemberId = "00000000-0000-4000-8000-000000000003";
const acceptedInstanceId = "00000000-0000-4000-8000-000000000101";
const pendingInstanceId = "00000000-0000-4000-8000-000000000102";
const sessionId = "00000000-0000-4000-8000-000000000201";
const accessToken = "test-access-token";
const otherSessionId = "00000000-0000-4000-8000-000000000202";
const otherAccessToken = "other-access-token";
const siteAdminId = "00000000-0000-4000-8000-000000000005";
const memberNodeId = btoa(`Account:${memberId}`);

const accountByUuidQuery = `
  query Account($uuid: UUID!) {
    accountByUuid(uuid: $uuid) {
      uuid
      email
      name
    }
  }
`;

const accountNodeQuery = `
  query AccountNode($id: ID!) {
    node(id: $id) {
      __typename
      ... on Account {
        uuid
        name
        email
        admin
        instances {
          totalCount
        }
      }
    }
  }
`;

const accountPrivateFieldsQuery = `
  query AccountPrivateFields($uuid: UUID!) {
    accountByUuid(uuid: $uuid) {
      uuid
      name
      email
      admin
      instances {
        totalCount
      }
    }
  }
`;

const accountInstancesQuery = `
  query AccountInstances($uuid: UUID!) {
    accountByUuid(uuid: $uuid) {
      instances {
        totalCount
        edges {
          created
          accepted
          admin
          node {
            uuid
            host
          }
        }
      }
    }
  }
`;

const accountByUuidResponse = {
  data: {
    accountByUuid: {
      uuid: accountId,
      email: "owner@example.com",
      name: "Owner",
    },
  },
};

const accountInstancesResponse = {
  data: {
    accountByUuid: {
      instances: {
        totalCount: 1,
        edges: [
          {
            created: "2026-06-24T00:00:00.000Z",
            accepted: "2026-06-24T00:00:00.000Z",
            admin: true,
            node: {
              uuid: acceptedInstanceId,
              host: "test-instance.drfed.org",
            },
          },
        ],
      },
    },
  },
};

describe("accountByUuid", () => {
  it("returns an account by UUID", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedAccounts(db);
      const auth = await createSession(db);

      const response = await post(
        { query: accountByUuidQuery, variables: { uuid: accountId } },
        auth,
      );

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), accountByUuidResponse);
    });
  });
});

describe("Account field authorization", () => {
  it("hides another account's private fields from a logged-in viewer", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedAccounts(db);
      // Authenticated as `accountId`, asking about `memberId`.
      const auth = await createSession(db);

      const response = await post(
        { query: accountPrivateFieldsQuery, variables: { uuid: memberId } },
        auth,
      );

      assert.equal(response.status, ok);
      const body = await response.json();
      // Public fields survive; each private field is individually null rather
      // than nulling the whole `Account`.
      assert.deepEqual(body.data.accountByUuid, {
        uuid: memberId,
        name: "Member",
        email: null,
        admin: null,
        instances: null,
      });
      assert.deepEqual(
        body.errors.map((e: { message: string }) => e.message).sort(),
        [
          "Not authorized to resolve Account.admin",
          "Not authorized to resolve Account.email",
          "Not authorized to resolve Account.instances",
        ],
      );
    });
  });

  it("shows an account its own private fields", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedAccounts(db);
      const auth = await createSession(db);

      const response = await post(
        { query: accountPrivateFieldsQuery, variables: { uuid: accountId } },
        auth,
      );

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), {
        data: {
          accountByUuid: {
            uuid: accountId,
            name: "Owner",
            email: "owner@example.com",
            admin: false,
            instances: { totalCount: 0 },
          },
        },
      });
    });
  });

  it("shows a site administrator another account's private fields", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedAccounts(db);
      await db.insert(schema.accounts).values({
        id: siteAdminId,
        email: "admin@example.com",
        name: "Site Admin",
        admin: true,
        created,
      });
      const auth = await createSession(db, {
        id: otherSessionId,
        account: siteAdminId,
        token: otherAccessToken,
      });

      const response = await post(
        { query: accountPrivateFieldsQuery, variables: { uuid: memberId } },
        auth,
      );

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), {
        data: {
          accountByUuid: {
            uuid: memberId,
            name: "Member",
            email: "member@example.com",
            admin: false,
            instances: { totalCount: 0 },
          },
        },
      });
    });
  });

  it("hides private fields reached through `node(id:)` from another account", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedAccounts(db);
      const auth = await createSession(db);

      const response = await post(
        { query: accountNodeQuery, variables: { id: memberNodeId } },
        auth,
      );

      assert.equal(response.status, ok);
      const body = await response.json();
      assert.deepEqual(body.data.node, {
        __typename: "Account",
        uuid: memberId,
        name: "Member",
        email: null,
        admin: null,
        instances: null,
      });
      assert.deepEqual(
        body.errors.map((e: { message: string }) => e.message).sort(),
        [
          "Not authorized to resolve Account.admin",
          "Not authorized to resolve Account.email",
          "Not authorized to resolve Account.instances",
        ],
      );
    });
  });

  it("hides private fields reached through `node(id:)` from an anonymous viewer", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedAccounts(db);

      // `node(id:)` carries no `authenticated` scope, unlike `accountByUuid`,
      // so this is the entry path that the field scopes alone must hold.
      const response = await post({
        query: accountNodeQuery,
        variables: { id: memberNodeId },
      });

      assert.equal(response.status, ok);
      const body = await response.json();
      assert.deepEqual(body.data.node, {
        __typename: "Account",
        uuid: memberId,
        name: "Member",
        email: null,
        admin: null,
        instances: null,
      });
      assert.deepEqual(
        body.errors.map((e: { message: string }) => e.message).sort(),
        [
          "Not authorized to resolve Account.admin",
          "Not authorized to resolve Account.email",
          "Not authorized to resolve Account.instances",
        ],
      );
    });
  });

  it("denies `accountByUuid` to an unauthenticated viewer", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedAccounts(db);

      const response = await post({
        query: accountByUuidQuery,
        variables: { uuid: accountId },
      });

      assert.equal(response.status, ok);
      const body = await response.json();
      assert.equal(body.data.accountByUuid, null);
      assert.equal(
        body.errors[0].message,
        "Not authorized to resolve Query.accountByUuid",
      );
    });
  });
});

describe("Account.instances", () => {
  it("returns the account's accepted instances", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedMembershipGraph(db);
      const auth = await createSession(db);

      const response = await post(
        { query: accountInstancesQuery, variables: { uuid: accountId } },
        auth,
      );

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), accountInstancesResponse);
    });
  });
});

/**
 * Opens an authenticated session for an already-seeded account, then returns
 * the request options carrying the session's bearer token.
 *
 * @param db The database to seed.
 * @param options The session id, account id, and bearer token to use.  Each
 *                defaults to {@link accountId}'s.
 * @returns Request options with an `Authorization` header for {@link post}.
 */
async function createSession(
  db: Database,
  options: { id?: string; account?: string; token?: string } = {},
): Promise<RequestInit> {
  const { id = sessionId, account = accountId, token = accessToken } = options;
  await db.insert(schema.sessions).values({
    id,
    accountId: account,
    tokenHash: await hashSecret(token),
  });
  return { headers: { authorization: `Bearer ${token}` } };
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

async function seedAccounts(db: Database): Promise<void> {
  await db.insert(schema.accounts).values([
    {
      id: accountId,
      email: "owner@example.com",
      name: "Owner",
      created,
    },
    {
      id: memberId,
      email: "member@example.com",
      name: "Member",
      created,
    },
    {
      id: pendingMemberId,
      email: "pending@example.com",
      name: "Pending",
      created,
    },
  ]);
}

async function seedMembershipGraph(db: Database): Promise<void> {
  await seedAccounts(db);
  await seedLocalInstances(db);
  await db.insert(schema.instanceMembers).values([
    {
      accountId,
      instanceId: acceptedInstanceId,
      admin: true,
      accepted,
      created,
    },
    {
      accountId: memberId,
      instanceId: acceptedInstanceId,
      admin: false,
      accepted,
      created,
    },
    {
      accountId: pendingMemberId,
      instanceId: acceptedInstanceId,
      admin: false,
      accepted: null,
      created,
    },
    {
      accountId,
      instanceId: pendingInstanceId,
      admin: false,
      accepted: null,
      created,
    },
  ]);
}

async function seedLocalInstances(db: Database): Promise<void> {
  await db.insert(schema.localInstances).values([
    {
      id: acceptedInstanceId,
      slug: "test-instance",
      expires,
    },
    {
      id: pendingInstanceId,
      slug: "pending-instance",
      expires,
    },
  ]);
  await db.insert(schema.instances).values([
    {
      id: acceptedInstanceId,
      localId: acceptedInstanceId,
      host: "test-instance.drfed.org",
      created,
    },
    {
      id: pendingInstanceId,
      localId: pendingInstanceId,
      host: "pending-instance.drfed.org",
      created,
    },
  ]);
}
