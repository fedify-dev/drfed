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
import { it } from "node:test";

import { migrate, relations, schema } from "@drfed/models";
import { ensureRemoteInstance } from "@drfed/models/instance";
import { storableText } from "@drfed/models/text";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

it("registers a remote host once, and never answers with a local instance", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const created = await ensureRemoteInstance(db, "remote.example");
    assert.equal(created?.host, "remote.example");
    assert.equal(created?.localId, null);
    assert.deepEqual(await ensureRemoteInstance(db, "remote.example"), created);
    assert.equal(await db.$count(schema.instances), 1);
    const localId = uuidV7();
    await db.insert(schema.localInstances).values({
      id: localId,
      slug: "local",
      expires: Temporal.Now.instant().add({ hours: 1 }),
    });
    await db
      .insert(schema.instances)
      .values({ id: localId, localId, host: "local.drfed.example" });
    assert.equal(await ensureRemoteInstance(db, "local.drfed.example"), null);
    assert.equal(await db.$count(schema.instances), 2);
  } finally {
    await client.close();
  }
});

it("tells text that PostgreSQL stores as it is", () => {
  assert.equal(storableText("a\u0001b\u{1F600}"), true);
  assert.equal(storableText("a\u0000b"), false);
  assert.equal(storableText("a\ud800b"), false);
  assert.equal(storableText("a\udc00b"), false);
});
