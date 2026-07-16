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

import { type Database, schema } from "@drfed/models";

export default async function seedData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await seedAccounts(tx);
  });
}

const accountId = "00000000-0000-4000-8000-000000000001";
const memberId = "00000000-0000-4000-8000-000000000002";
const pendingMemberId = "00000000-0000-4000-8000-000000000003";
const created = new Date("2026-06-24T00:00:00.000Z");

async function seedAccounts(db: Database): Promise<void> {
  await db
    .insert(schema.accounts)
    .values([
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
    ])
    .onConflictDoNothing();
}
