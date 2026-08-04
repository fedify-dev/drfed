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

const accountByUuidQuery = `
  query Account($uuid: UUID!) {
    accountByUuid(uuid: $uuid) {
      uuid
      email
      name
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
            location
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
              location: "Local",
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

      const response = await post({
        query: accountByUuidQuery,
        variables: { uuid: accountId },
      });

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), accountByUuidResponse);
    });
  });
});

describe("Account.instances", () => {
  it("returns the account's accepted instances", async () => {
    await withTestHarness(async ({ db, post }) => {
      await seedMembershipGraph(db);

      const response = await post({
        query: accountInstancesQuery,
        variables: { uuid: accountId },
      });

      assert.equal(response.status, ok);
      assert.deepEqual(await response.json(), accountInstancesResponse);
    });
  });
});

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
  await db.insert(schema.instances).values([
    {
      id: acceptedInstanceId,
      location: "Local",
      created,
    },
    {
      id: pendingInstanceId,
      location: "Local",
      created,
    },
  ]);
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
}
