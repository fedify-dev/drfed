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

// oxlint-disable id-length max-statements no-await-in-loop

import assert from "node:assert/strict";
import { it } from "node:test";

import { migrate, relations, schema } from "@drfed/models";
import {
  type OutboundSettlement,
  inboundActorRows,
  receiveInbound,
  recordInbound,
  recordOutbound,
  settleOutbound,
} from "@drfed/models/activity-log";
import { observeKeyVersion } from "@drfed/models/key";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, isNull } from "drizzle-orm";
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
    const body = new TextEncoder().encode('{"type":"Create","type":"Follow"}');
    const now = Temporal.Now.instant();
    const observed = {
      verificationResult: "invalid_signature",
      body,
      created: now,
      completed: now,
    } as const;
    const inbound = await recordInbound(db, {
      ...entry,
      ...observed,
      status: "unverified",
      verificationKeyId: version.id,
    });
    assert.deepEqual(inbound.payload, entry.payload);
    assert.deepEqual(new Uint8Array(inbound.body!), body);
    const presetId = uuidV7();
    const acknowledged = await recordInbound(db, {
      ...entry,
      ...observed,
      id: presetId,
      status: "acknowledged",
    });
    assert.equal(acknowledged.id, presetId);
    assert.equal(await receiveInbound(db, presetId), true);
    assert.equal(
      (await db.query.activityLogs.findFirst({ where: { id: presetId } }))
        ?.status,
      "received",
    );
    // Only an acknowledged inbound log is received later.
    assert.equal(await receiveInbound(db, presetId), false);
    assert.equal(await receiveInbound(db, inbound.id), false);
    const unparsed = await recordInbound(db, {
      ...entry,
      ...observed,
      payload: undefined,
      status: "unverified",
      error: "threw\u0000",
      responseBody: "\u0000",
    });
    // Nor does text hold U+0000, which an error or a response may carry.
    assert.deepEqual(
      [unparsed.error, unparsed.responseBody],
      ["threw\ufffd", "\ufffd"],
    );
    assert.equal(
      await db.$count(
        schema.activityLogs,
        and(
          eq(schema.activityLogs.id, unparsed.id),
          isNull(schema.activityLogs.payload),
        ),
      ),
      1,
    );
    const inboundRow = {
      ...entry,
      ...observed,
      id: uuidV7(),
      direction: "inbound",
      status: "received",
      body: Buffer.from(body),
    } as const;
    await assert.rejects(
      db
        .insert(schema.activityLogs)
        .values({ ...inboundRow, verificationResult: null }),
    );
    await assert.rejects(
      db.insert(schema.activityLogs).values({ ...inboundRow, body: null }),
    );
    await assert.rejects(
      db.insert(schema.activityLogs).values({ ...inboundRow, completed: null }),
    );
    await assert.rejects(
      db.insert(schema.activityLogs).values({
        ...entry,
        id: uuidV7(),
        direction: "outbound",
        status: "queued",
        verificationResult: "verified",
      }),
    );
    await assert.rejects(
      db
        .delete(schema.keyVersions)
        .where(eq(schema.keyVersions.id, version.id)),
    );
    await assert.rejects(
      db.delete(schema.keys).where(eq(schema.keys.id, version.keyId)),
    );
    await assert.rejects(
      db.insert(schema.activityLogs).values({ ...inboundRow, status: "sent" }),
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
      db.insert(schema.activityLogs).values({ ...inboundRow, statusCode: 600 }),
    );
    const outgoing = {
      ...entry,
      activityIri: "https://local.example/activity/1",
    };
    const row = await recordOutbound(db, outgoing);
    const current = (id = row.id) =>
      db.query.activityLogs.findFirst({
        where: { id },
        with: { attempts: { orderBy: { created: "asc", id: "asc" } } },
      });
    const attempts = async (id = row.id) =>
      ((await current(id))?.attempts ?? []).map((attempt) => [
        attempt.succeeded,
        attempt.statusCode,
        attempt.error,
        attempt.responseBody,
      ]);
    assert.equal((await current())?.status, "queued");
    assert.equal((await current())?.completed, null);
    await assert.rejects(
      db
        .update(schema.activityLogs)
        .set({ completed: now })
        .where(eq(schema.activityLogs.id, row.id)),
    );
    assert.equal(
      await settleOutbound(db, {
        ...outgoing,
        status: "failed",
        statusCode: 503,
        error: "Unavailable",
        responseBody: "Later",
        attempted: true,
      }),
      true,
    );
    assert.equal((await current())?.statusCode, 503);
    await settleOutbound(db, { ...outgoing, status: "sent", attempted: true });
    const sent = await current();
    assert.equal(sent?.status, "sent");
    assert.deepEqual(
      [sent?.statusCode, sent?.error, sent?.responseBody],
      [null, null, null],
    );
    assert.ok(sent?.completed != null);
    assert.deepEqual(await attempts(), [
      [false, 503, "Unavailable", "Later"],
      [true, null, null, null],
    ]);
    assert.equal(
      await settleOutbound(db, {
        ...outgoing,
        status: "permanently_failed",
        statusCode: 410,
        error: "Gone",
        attempted: true,
      }),
      false,
    );
    assert.equal((await current())?.status, "sent");
    assert.equal((await attempts()).length, 2);
    const [attempt] = (await current())?.attempts ?? [];
    await assert.rejects(
      db.insert(schema.activityLogAttempts).values({
        ...attempt!,
        id: uuidV7(),
        succeeded: true,
        error: "Unavailable",
      }),
    );
    await assert.rejects(
      db
        .insert(schema.activityLogAttempts)
        .values({ ...attempt!, id: uuidV7(), statusCode: 600 }),
    );
    const final = async (
      activityIri: string,
      settlement: Omit<OutboundSettlement, "activityIri" | "inboxUrl">,
    ) => {
      const log = await recordOutbound(db, { ...outgoing, activityIri });
      await settleOutbound(db, { ...outgoing, ...settlement, activityIri });
      return log.id;
    };
    const abandoned = await final("https://local.example/activity/2", {
      status: "abandoned",
      statusCode: 503,
      error: "Unavailable",
      attempted: true,
    });
    assert.equal((await current(abandoned))?.status, "abandoned");
    assert.deepEqual(await attempts(abandoned), [
      [false, 503, "Unavailable", null],
    ]);
    const dropped = await final("https://local.example/activity/3", {
      status: "permanently_failed",
      error: "Circuit breaker held activity expired.",
      attempted: false,
    });
    assert.equal((await current(dropped))?.status, "permanently_failed");
    assert.ok((await current(dropped))?.completed != null);
    assert.deepEqual(await attempts(dropped), []);
    const unstorable = await final("https://local.example/activity/5", {
      status: "failed",
      statusCode: 500,
      error: "Failed:\nerror\u0000details",
      responseBody: "error\u0000details",
      attempted: true,
    });
    assert.deepEqual(
      [
        (await current(unstorable))?.status,
        (await current(unstorable))?.responseBody,
      ],
      ["failed", "error\ufffddetails"],
    );
    assert.deepEqual(await attempts(unstorable), [
      [false, 500, "Failed:\nerror\ufffddetails", "error\ufffddetails"],
    ]);
    const retried = {
      ...outgoing,
      activityIri: "https://local.example/activity/4",
    };
    const deliveries = [];
    for (const [statusCode, error] of [
      [503, "First"],
      [502, "Second"],
    ] as const) {
      deliveries.push(await recordOutbound(db, retried));
      await settleOutbound(db, {
        ...retried,
        status: "failed",
        statusCode,
        error,
        attempted: true,
      });
    }
    assert.deepEqual(
      (
        await db.query.activityLogs.findMany({
          where: { activityIri: retried.activityIri },
          orderBy: { id: "asc" },
        })
      ).map((log) => [log.id, log.status, log.statusCode, log.error]),
      [
        [deliveries[0]!.id, "failed", 503, "First"],
        [deliveries[1]!.id, "failed", 502, "Second"],
      ],
    );
    assert.equal(
      await settleOutbound(db, {
        ...retried,
        id: deliveries[0]!.id,
        status: "sent",
        attempted: true,
      }),
      true,
    );
    assert.equal((await current(deliveries[1]!.id))?.status, "failed");
    await db
      .delete(schema.instances)
      .where(eq(schema.instances.id, instanceId));
    assert.equal(await db.$count(schema.activityLogs), 0);
    assert.equal(await db.$count(schema.activityLogAttempts), 0);
    await db
      .delete(schema.keyVersions)
      .where(eq(schema.keyVersions.id, version.id));
  } finally {
    await client.close();
  }
});

it("keeps one row per log and actor and requires a role", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const instanceId = uuidV7();
    const actorId = uuidV7();
    const otherId = uuidV7();
    await db
      .insert(schema.instances)
      .values({ id: instanceId, host: "local.example" });
    for (const [id, username] of [
      [actorId, "alice"],
      [otherId, "bob"],
    ] as const) {
      const iri = `https://local.example/users/${id}`;
      await db.insert(schema.resources).values({ id, iri, kind: "actor" });
      await db.insert(schema.actors).values({
        id,
        type: "Person",
        username,
        instanceId,
        inboxUrl: `${iri}/inbox`,
      });
    }
    const collection = "https://local.example/collections/1";
    assert.deepEqual(
      inboundActorRows({
        actorId,
        addressed: [
          { actorId, viaCollectionIri: collection },
          { actorId },
          { actorId: otherId, viaCollectionIri: collection },
        ],
      }),
      [
        { actorId, inboxOwner: true, addressed: true, viaCollectionIri: null },
        { actorId: otherId, addressed: true, viaCollectionIri: collection },
      ],
    );
    const log = await recordInbound(db, {
      instanceId,
      actorId,
      inboxUrl: `https://local.example/users/${actorId}/inbox`,
      status: "received",
      verificationResult: "verified",
      body: new TextEncoder().encode("{}"),
      payload: {},
      addressed: [{ actorId }, { actorId: otherId }],
      created: Temporal.Now.instant(),
      completed: Temporal.Now.instant(),
    });
    const sent = await recordOutbound(db, {
      instanceId,
      actorId,
      inboxUrl: "https://remote.example/inbox",
      activityIri: "https://local.example/activity/1",
      payload: {},
      recipientIris: ["https://remote.example/a", "https://remote.example/b"],
    });
    assert.deepEqual(sent.recipientIris, [
      "https://remote.example/a",
      "https://remote.example/b",
    ]);
    const links = await db.query.activityLogActors.findMany({
      orderBy: { logId: "asc", actorId: "asc" },
    });
    assert.deepEqual(
      links.map((link) => [
        link.logId,
        link.actorId,
        link.inboxOwner,
        link.addressed,
        link.sender,
      ]),
      [
        [log.id, actorId, true, true, false],
        [log.id, otherId, false, true, false],
        [sent.id, actorId, false, false, true],
      ],
    );
    await assert.rejects(
      db
        .insert(schema.activityLogActors)
        .values({ logId: log.id, actorId, sender: true }),
    );
    await assert.rejects(
      db
        .insert(schema.activityLogActors)
        .values({ logId: sent.id, actorId: otherId }),
    );
    const found = await db.query.actors.findFirst({
      where: { id: actorId },
      with: { activityLogs: { orderBy: { created: "desc", id: "desc" } } },
    });
    assert.deepEqual(
      found?.activityLogs.map((row) => row.id),
      [sent.id, log.id],
    );
  } finally {
    await client.close();
  }
});
