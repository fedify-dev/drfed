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

import { createYogaServer } from "@drfed/graphql";
import createFederation, { buildFederation } from "@drfed/graphql/federation";
import { MemoryKvStore } from "@fedify/fedify";
import { describe, it } from "@logtape/testing-node/autoload";

import { withTemporaryDatabase, withTestHarness } from "./harness.test.ts";

const origin = new URL("https://drfed.test");

describe("createFederation()", () => {
  it("registers the actor URI layout", async () => {
    await withTemporaryDatabase(async (db) => {
      const federation = await createFederation(db, {
        kv: new MemoryKvStore(),
      });
      const ctx = federation.createContext(origin, undefined);
      assert.equal(
        ctx.getActorUri("identifier").href,
        "https://drfed.test/users/identifier",
      );
      assert.equal(
        ctx.getInboxUri("identifier").href,
        "https://drfed.test/users/identifier/inbox",
      );
      assert.equal(ctx.getInboxUri().href, "https://drfed.test/inbox");
      assert.equal(
        ctx.getOutboxUri("identifier").href,
        "https://drfed.test/users/identifier/outbox",
      );
      assert.equal(
        ctx.getFollowersUri("identifier").href,
        "https://drfed.test/users/identifier/followers",
      );
      assert.equal(
        ctx.getFollowingUri("identifier").href,
        "https://drfed.test/users/identifier/followees",
      );
      assert.equal(
        ctx.getFeaturedUri("identifier").href,
        "https://drfed.test/users/identifier/featured",
      );
    });
  });

  it("builds independent instances from one builder", async () => {
    await withTemporaryDatabase(async (db) => {
      const builder = buildFederation(db);
      const first = await builder.build({ kv: new MemoryKvStore() });
      const second = await builder.build({ kv: new MemoryKvStore() });
      assert.notEqual(first, second);
    });
  });
});

describe("createYogaServer()", () => {
  it("does not mutate the federation instance", async () => {
    await withTestHarness(({ db, mailer, federation }) => {
      assert.doesNotThrow(() => createYogaServer(db, federation, { mailer }));
    });
  });
});
