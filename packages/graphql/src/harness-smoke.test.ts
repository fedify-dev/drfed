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
import { describe, it } from "node:test";

import { schema } from "@drfed/models";

import { withTemporaryDatabase, withTestHarness } from "./harness.test.ts";

describe("withTemporaryDatabase()", () => {
  it("provides a migrated temporary database", async () => {
    await withTemporaryDatabase(async (db) => {
      const accounts = await db.select().from(schema.accounts);
      assert.deepEqual(accounts, []);
    });
  });
});

describe("withTestHarness()", () => {
  it("posts requests to a Yoga server", async () => {
    await withTestHarness(async ({ post }) => {
      const response = await post({ query: "{ __typename }" });
      assert.ok(response.ok);
      assert.deepEqual(await response.json(), {
        data: { __typename: "Query" },
      });
    });
  });
});
