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
} from "@drfed/models/activity-delivery";
import { observeKeyVersion } from "@drfed/models/key";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

it("enforces delivery constraints, key retention and outbound state transitions", async () => {
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
      (await db.query.activityDeliveries.findFirst({ where: { id: presetId } }))
        ?.status,
      "received",
    );
    // Only an acknowledged inbound delivery is received later.
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
        schema.activityDeliveries,
        and(
          eq(schema.activityDeliveries.id, unparsed.id),
          isNull(schema.activityDeliveries.payload),
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
        .insert(schema.activityDeliveries)
        .values({ ...inboundRow, verificationResult: null }),
    );
    await assert.rejects(
      db
        .insert(schema.activityDeliveries)
        .values({ ...inboundRow, body: null }),
    );
    await assert.rejects(
      db
        .insert(schema.activityDeliveries)
        .values({ ...inboundRow, completed: null }),
    );
    await assert.rejects(
      db.insert(schema.activityDeliveries).values({
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
      db
        .insert(schema.activityDeliveries)
        .values({ ...inboundRow, status: "sent" }),
    );
    await assert.rejects(
      db.insert(schema.activityDeliveries).values({
        ...entry,
        id: uuidV7(),
        direction: "outbound",
        status: "queued",
        verificationKeyId: version.id,
      }),
    );
    await assert.rejects(
      db
        .insert(schema.activityDeliveries)
        .values({ ...inboundRow, statusCode: 600 }),
    );
    const outgoing = {
      ...entry,
      activityIri: "https://local.example/activity/1",
    };
    const row = await recordOutbound(db, outgoing);
    const current = (id = row.id) =>
      db.query.activityDeliveries.findFirst({
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
        .update(schema.activityDeliveries)
        .set({ completed: now })
        .where(eq(schema.activityDeliveries.id, row.id)),
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
      db.insert(schema.activityDeliveryAttempts).values({
        ...attempt!,
        id: uuidV7(),
        succeeded: true,
        error: "Unavailable",
      }),
    );
    await assert.rejects(
      db
        .insert(schema.activityDeliveryAttempts)
        .values({ ...attempt!, id: uuidV7(), statusCode: 600 }),
    );
    const final = async (
      activityIri: string,
      settlement: Omit<OutboundSettlement, "activityIri" | "inboxUrl">,
    ) => {
      const delivery = await recordOutbound(db, { ...outgoing, activityIri });
      await settleOutbound(db, { ...outgoing, ...settlement, activityIri });
      return delivery.id;
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
        await db.query.activityDeliveries.findMany({
          where: { activityIri: retried.activityIri },
          orderBy: { id: "asc" },
        })
      ).map((delivery) => [
        delivery.id,
        delivery.status,
        delivery.statusCode,
        delivery.error,
      ]),
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
    assert.equal(await db.$count(schema.activityDeliveries), 0);
    assert.equal(await db.$count(schema.activityDeliveryAttempts), 0);
    await db
      .delete(schema.keyVersions)
      .where(eq(schema.keyVersions.id, version.id));
  } finally {
    await client.close();
  }
});

it("keeps one row per delivery and actor and requires a role", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const instanceId = uuidV7();
    const otherInstanceId = uuidV7();
    const actorId = uuidV7();
    const otherId = uuidV7();
    const strangerId = uuidV7();
    const remoteId = uuidV7();
    await db.insert(schema.instances).values([
      { id: instanceId, host: "local.example" },
      { id: otherInstanceId, host: "other.example" },
    ]);
    for (const [id, username, instance, local] of [
      [actorId, "alice", instanceId, true],
      [otherId, "bob", instanceId, true],
      [strangerId, "carol", otherInstanceId, true],
      [remoteId, "dave", instanceId, false],
    ] as const) {
      const iri = `https://local.example/users/${id}`;
      if (local) await db.insert(schema.localActors).values({ id });
      await db.insert(schema.resources).values({ id, iri, kind: "actor" });
      await db.insert(schema.actors).values({
        id,
        localId: local ? id : null,
        type: "Person",
        username,
        instanceId: instance,
        inboxUrl: `${iri}/inbox`,
      });
    }
    const [first, second] = [
      "https://local.example/collections/1",
      "https://local.example/collections/2",
    ];
    // Every way an actor was addressed is kept, whatever order it comes in.
    for (const collections of [
      [first, second],
      [second, first],
    ]) {
      assert.deepEqual(
        inboundActorRows({
          actorId,
          addressed: [
            ...collections.map((viaCollectionIri) => ({
              actorId,
              viaCollectionIri,
            })),
            { actorId },
            { actorId, viaCollectionIri: first },
            { actorId: otherId, viaCollectionIri: first },
          ],
        }),
        [
          {
            actorId,
            inboxOwner: true,
            addressed: true,
            addressedDirectly: true,
            collectionIris: [first, second],
          },
          {
            actorId: otherId,
            addressed: true,
            addressedDirectly: false,
            collectionIris: [first],
          },
        ],
      );
    }
    const created = Temporal.Instant.from("2026-09-01T00:00:00.123456Z");
    const inbound = {
      instanceId,
      inboxUrl: `https://local.example/users/${actorId}/inbox`,
      status: "received",
      verificationResult: "verified",
      body: new TextEncoder().encode("{}"),
      payload: {},
      created,
      completed: created,
    } as const;
    const delivery = await recordInbound(db, {
      ...inbound,
      actorId,
      addressed: [
        { actorId, viaCollectionIri: second },
        { actorId },
        { actorId, viaCollectionIri: first },
        { actorId: otherId, viaCollectionIri: first },
      ],
    });
    const outbound = {
      instanceId,
      inboxUrl: "https://remote.example/inbox",
      activityIri: "https://local.example/activity/1",
      payload: {},
    } as const;
    const sent = await recordOutbound(db, {
      ...outbound,
      actorId,
      recipientIris: ["https://remote.example/a", "https://remote.example/b"],
    });
    assert.deepEqual(sent.recipientIris, [
      "https://remote.example/a",
      "https://remote.example/b",
    ]);
    const links = await db.query.activityDeliveryActors.findMany({
      orderBy: { deliveryId: "asc", actorId: "asc" },
      with: { collections: { orderBy: { collectionIri: "asc" } } },
    });
    assert.deepEqual(
      links.map((link) => [
        link.deliveryId,
        link.actorId,
        link.inboxOwner,
        link.addressed,
        link.addressedDirectly,
        link.sender,
        link.collections.map(({ collectionIri }) => collectionIri),
      ]),
      [
        [delivery.id, actorId, true, true, true, false, [first, second]],
        [delivery.id, otherId, false, true, false, false, [first]],
        [sent.id, actorId, false, false, false, true, []],
      ],
    );
    // Each row copies the created of its delivery, which orders an actor's
    // deliveries.
    assert.deepEqual(
      links.map((link) => link.created.toString()),
      [delivery, delivery, sent].map((row) => row.created.toString()),
    );
    await assert.rejects(
      db
        .insert(schema.activityDeliveryActors)
        .values({ deliveryId: delivery.id, actorId, sender: true, created }),
    );
    await assert.rejects(
      db
        .insert(schema.activityDeliveryActors)
        .values({ deliveryId: sent.id, actorId: otherId, created }),
    );
    await assert.rejects(
      db.insert(schema.activityDeliveryActors).values({
        deliveryId: sent.id,
        actorId: otherId,
        inboxOwner: true,
        addressedDirectly: true,
        created,
      }),
    );
    await assert.rejects(
      db.insert(schema.activityDeliveryActorCollections).values({
        deliveryId: sent.id,
        actorId: otherId,
        collectionIri: first,
      }),
    );
    // Only local actors of the delivery's instance, in any role.
    const deliveries = await db.$count(schema.activityDeliveries);
    for (const refused of [
      () => recordOutbound(db, { ...outbound, actorId: strangerId }),
      () => recordOutbound(db, { ...outbound, actorId: remoteId }),
      () => recordInbound(db, { ...inbound, actorId: remoteId }),
      () =>
        recordInbound(db, {
          ...inbound,
          actorId,
          addressed: [{ actorId: strangerId }],
        }),
      () =>
        recordInbound(db, {
          ...inbound,
          addressed: [{ actorId: remoteId, viaCollectionIri: first }],
        }),
    ]) {
      await assert.rejects(refused, /local actors of its instance/u);
    }
    assert.equal(await db.$count(schema.activityDeliveries), deliveries);
    const found = await db.query.actors.findFirst({
      where: { id: actorId },
      with: {
        activityDeliveryLinks: {
          orderBy: { created: "desc", deliveryId: "desc" },
        },
      },
    });
    assert.deepEqual(
      found?.activityDeliveryLinks.map((link) => link.deliveryId),
      [sent.id, delivery.id],
    );
    await db
      .delete(schema.activityDeliveries)
      .where(eq(schema.activityDeliveries.id, delivery.id));
    assert.equal(await db.$count(schema.activityDeliveryActorCollections), 0);
  } finally {
    await client.close();
  }
});
