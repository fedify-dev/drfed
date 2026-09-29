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

// oxlint-disable id-length max-statements

import assert from "node:assert/strict";
import { it } from "node:test";

import { migrate, relations, schema } from "@drfed/models";
import {
  recordInbound,
  recordOutbound,
  settleOutbound,
} from "@drfed/models/activity-log";
import { observeKeyVersion } from "@drfed/models/key";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

it("enforces log constraints, key retention and outbound state transitions", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const instanceId = uuidV7();
    await db
      .insert(schema.instances)
      .values({ id: instanceId, host: "local.example" });
    const version = await observeKeyVersion(db, {
      iri: "https://remote.example/key",
      publicKey: { kty: "RSA", e: "AQAB", n: "test" },
    });
    const entry = {
      instanceId,
      inboxUrl: "https://local.example/inbox",
      payload: { type: "Create", bcc: ["private"] },
    };
    const inbound = await recordInbound(db, {
      ...entry,
      status: "unverified",
      verificationKeyId: version.id,
    });
    assert.deepEqual(inbound.payload, entry.payload);
    await assert.rejects(
      db
        .delete(schema.keyVersions)
        .where(eq(schema.keyVersions.id, version.id)),
    );
    await assert.rejects(
      db.delete(schema.keys).where(eq(schema.keys.id, version.keyId)),
    );
    await assert.rejects(
      db.insert(schema.activityLogs).values({
        ...entry,
        id: uuidV7(),
        direction: "inbound",
        status: "sent",
      }),
    );
    await assert.rejects(
      db.insert(schema.activityLogs).values({
        ...entry,
        id: uuidV7(),
        direction: "outbound",
        status: "queued",
        verificationKeyId: version.id,
      }),
    );
    await assert.rejects(
      db.insert(schema.activityLogs).values({
        ...entry,
        id: uuidV7(),
        direction: "inbound",
        status: "received",
        statusCode: 600,
      }),
    );
    const outgoing = {
      ...entry,
      activityIri: "https://local.example/activity/1",
    };
    const row = await recordOutbound(db, outgoing);
    const current = () =>
      db.query.activityLogs.findFirst({ where: { id: row.id } });
    assert.equal((await current())?.status, "queued");
    await settleOutbound(db, {
      ...outgoing,
      status: "failed",
      statusCode: 503,
      error: "Unavailable",
    });
    await settleOutbound(db, { ...outgoing, status: "sent" });
    assert.equal((await current())?.status, "failed");
    await settleOutbound(db, {
      ...outgoing,
      status: "permanently_failed",
      statusCode: 410,
    });
    await settleOutbound(db, {
      ...outgoing,
      status: "failed",
      statusCode: 503,
    });
    assert.equal((await current())?.statusCode, 410);
    const second = await recordOutbound(db, {
      ...outgoing,
      activityIri: "https://local.example/activity/2",
    });
    await settleOutbound(db, {
      ...outgoing,
      activityIri: second.activityIri!,
      status: "sent",
    });
    assert.equal(
      (await db.query.activityLogs.findFirst({ where: { id: second.id } }))
        ?.status,
      "sent",
    );
    await db
      .delete(schema.instances)
      .where(eq(schema.instances.id, instanceId));
    assert.equal(await db.$count(schema.activityLogs), 0);
    await db
      .delete(schema.keyVersions)
      .where(eq(schema.keyVersions.id, version.id));
  } finally {
    await client.close();
  }
});
