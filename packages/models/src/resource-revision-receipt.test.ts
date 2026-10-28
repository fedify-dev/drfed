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

// Keep lock steps and dependent database operations sequential.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  linkInboundActivity,
  recordFetchedObject,
  recordInbound,
} from "@drfed/models/activity-delivery";
import {
  captureLegacyResourceRevision,
  loadResourceRevision,
} from "@drfed/models/resource-revision";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";

import {
  type RevisionFixture,
  revisionBackends,
  revisionConnection,
  revisionPostgresUrl,
  withRevisionDatabase,
} from "./resource-revision-fixture.ts";

async function receivedPair(fixture: RevisionFixture, fetched = true) {
  const receiverId = uuidV7();
  const remoteId = uuidV7();
  const actorId = uuidV7();
  const activityId = uuidV7();
  const objectId = uuidV7();
  const activityIri = `https://remote.test/activities/${activityId}`;
  const objectIri = `https://remote.test/objects/${objectId}`;
  const objectDocument = {
    id: objectIri,
    type: "Note",
    content: "private original",
  };
  const activityDocument = {
    id: activityIri,
    type: "Create",
    actor: "https://remote.test/alice",
    object: fetched ? objectIri : objectDocument,
  };
  await fixture.query(
    "INSERT INTO instances (id,host) VALUES ($1,$2),($3,$4)",
    [
      receiverId,
      `receiver-${receiverId}.test`,
      remoteId,
      `remote-${remoteId}.test`,
    ],
  );
  await fixture.query(
    "INSERT INTO resources (id,iri,kind) VALUES ($1,$2,'actor'),($3,$4,'object'),($5,$6,'activity')",
    [
      actorId,
      `https://remote.test/alice/${actorId}`,
      objectId,
      objectIri,
      activityId,
      activityIri,
    ],
  );
  await fixture.query(
    "INSERT INTO actors (id,type,instance_id,inbox_url) VALUES ($1,'Person',$2,'https://remote.test/inbox')",
    [actorId, remoteId],
  );
  await fixture.query(
    "INSERT INTO activities (id,type,actor_id,object_id,published,document) VALUES ($1,'Create',$2,$3,now(),$4::json)",
    [activityId, actorId, objectId, JSON.stringify(activityDocument)],
  );
  await fixture.query(
    "INSERT INTO objects (id,type,actor_id,activity_id,content_html,fetched,document) VALUES ($1,'Note',$2,$3,'private original',$4::boolean,$5::json)",
    [objectId, actorId, activityId, fetched, JSON.stringify(objectDocument)],
  );
  const revisions = await fixture.db.transaction(async (tx) => ({
    activity: await captureLegacyResourceRevision(tx, activityId),
    object: await captureLegacyResourceRevision(tx, objectId),
  }));
  const now = Temporal.Now.instant();
  const delivery = await recordInbound(fixture.db, {
    instanceId: receiverId,
    status: "received",
    verificationResult: "verified",
    verificationMechanism: "http_signature",
    inboxUrl: "https://receiver.test/inbox",
    activityIri,
    payload: activityDocument,
    body: Buffer.from(JSON.stringify(activityDocument)),
    created: now,
    completed: now,
    statusCode: 202,
  });
  return {
    receiverId,
    remoteId,
    actorId,
    activityId,
    objectId,
    objectIri,
    activityIri,
    activityDocument,
    objectDocument,
    revisions,
    delivery,
  };
}

async function receiptRoles(fixture: RevisionFixture, deliveryId: Uuid) {
  const { rows } = await fixture.query<{ role: string }>(
    "SELECT role FROM revision_receipts WHERE delivery_id=$1 ORDER BY role",
    [deliveryId],
  );
  return rows.map((row) => row.role);
}

for (const backend of revisionBackends) {
  it(
    `recomputes receipt evidence without rewriting retained documents on ${backend}`,
    { skip: backend === "postgres" && !revisionPostgresUrl },
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const pair = await receivedPair(fixture);
        assert.equal(
          await linkInboundActivity(fixture.db, pair.delivery.id),
          true,
        );
        assert.deepEqual(await receiptRoles(fixture, pair.delivery.id), [
          "activity",
        ]);
        await recordFetchedObject(
          fixture.db,
          pair.delivery.id,
          pair.objectDocument,
        );
        assert.deepEqual(await receiptRoles(fixture, pair.delivery.id), [
          "activity",
          "object",
        ]);
        await recordFetchedObject(fixture.db, pair.delivery.id, {
          ...pair.objectDocument,
          content: "different fetch",
        });
        assert.deepEqual(await receiptRoles(fixture, pair.delivery.id), [
          "activity",
        ]);
        await recordFetchedObject(
          fixture.db,
          pair.delivery.id,
          pair.objectDocument,
        );
        const laterId = uuidV7();
        const otherInstance = uuidV7();
        const laterIri = `https://remote.test/activities/${laterId}`;
        const laterDocument = {
          ...pair.activityDocument,
          id: laterIri,
          object: { ...pair.objectDocument, content: "later public value" },
          to: ["https://www.w3.org/ns/activitystreams#Public"],
        };
        await fixture.query("INSERT INTO instances (id,host) VALUES ($1,$2)", [
          otherInstance,
          `other-${otherInstance}.test`,
        ]);
        await fixture.query(
          "INSERT INTO resources (id,iri,kind) VALUES ($1,$2,'activity')",
          [laterId, laterIri],
        );
        await fixture.query(
          "INSERT INTO activities (id,type,actor_id,object_id,published,document) VALUES ($1,'Create',$2,$3,now(),$4::json)",
          [laterId, pair.actorId, pair.objectId, JSON.stringify(laterDocument)],
        );
        await fixture.db.transaction((tx) =>
          captureLegacyResourceRevision(tx, laterId),
        );
        const laterDelivery = await recordInbound(fixture.db, {
          instanceId: otherInstance,
          status: "received",
          verificationResult: "verified",
          inboxUrl: "https://other.test/inbox",
          activityIri: laterIri,
          payload: laterDocument,
          body: Buffer.from(JSON.stringify(laterDocument)),
          created: Temporal.Now.instant(),
          completed: Temporal.Now.instant(),
        });
        await linkInboundActivity(fixture.db, laterDelivery.id);
        assert.deepEqual(await receiptRoles(fixture, laterDelivery.id), [
          "activity",
        ]);
        assert.deepEqual(
          (await loadResourceRevision(fixture.db, pair.revisions.object))
            ?.document,
          pair.objectDocument,
        );
        await fixture.query("DELETE FROM objects WHERE id=$1", [pair.objectId]);
        assert.deepEqual(await receiptRoles(fixture, pair.delivery.id), [
          "activity",
        ]);
        assert.deepEqual(
          (await loadResourceRevision(fixture.db, pair.revisions.object))
            ?.document,
          pair.objectDocument,
        );
        await fixture.query("DELETE FROM activities WHERE id=$1", [
          pair.activityId,
        ]);
        assert.deepEqual(await receiptRoles(fixture, pair.delivery.id), []);
        assert.deepEqual(
          (await loadResourceRevision(fixture.db, pair.revisions.activity))
            ?.document,
          pair.activityDocument,
        );
        await fixture.query("DELETE FROM instances WHERE id=$1", [
          otherInstance,
        ]);
        assert.deepEqual(await receiptRoles(fixture, laterDelivery.id), []);
        assert.ok(
          await loadResourceRevision(fixture.db, pair.revisions.activity),
        );
      });
    },
  );
}

const BARRIER_KEY = "51615027";
async function waitsFor(
  fixture: RevisionFixture,
  blockedPid: string,
  blockingPid: string,
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const { rows } = await fixture.query<{ blocked: boolean }>(
      "SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked",
      [blockedPid, blockingPid],
    );
    if (rows[0]?.blocked === true) return;
    // oxlint-disable-next-line no-await-in-loop
    await delay(10);
  }
  throw new Error("The expected database lock dependency was not observed.");
}

for (const operation of ["fetch", "first-link"] as const) {
  for (const deletionFirst of [false, true]) {
    it(
      `serializes ${operation} with object deletion (${deletionFirst ? "delete first" : "recompute first"})`,
      { skip: !revisionPostgresUrl, timeout: 30_000 },
      async () => {
        await withRevisionDatabase("postgres", async (fixture) => {
          assert.ok(fixture.url);
          const pair = await receivedPair(fixture);
          if (operation === "fetch") {
            await linkInboundActivity(fixture.db, pair.delivery.id);
          } else {
            await recordFetchedObject(
              fixture.db,
              pair.delivery.id,
              pair.objectDocument,
            );
          }
          const recompute = revisionConnection(fixture.url);
          const deleting = revisionConnection(fixture.url);
          const barrier = revisionConnection(fixture.url);
          let work: Promise<unknown> | undefined;
          let removal: Promise<unknown> | undefined;
          try {
            const recomputePid = (
              await recompute.query<{ pid: string }>(
                "SELECT pg_backend_pid()::text AS pid",
              )
            ).rows[0]!.pid;
            const deletingPid = (
              await deleting.query<{ pid: string }>(
                "SELECT pg_backend_pid()::text AS pid",
              )
            ).rows[0]!.pid;
            const barrierPid = (
              await barrier.query<{ pid: string }>(
                "SELECT pg_backend_pid()::text AS pid",
              )
            ).rows[0]!.pid;
            const run = () =>
              operation === "fetch"
                ? recordFetchedObject(
                    recompute.db,
                    pair.delivery.id,
                    pair.objectDocument,
                  )
                : linkInboundActivity(recompute.db, pair.delivery.id);
            if (deletionFirst) {
              await deleting.query("BEGIN");
              await deleting.query("DELETE FROM objects WHERE id=$1", [
                pair.objectId,
              ]);
              work = run();
              void work.catch(() => undefined);
              await waitsFor(fixture, recomputePid, deletingPid);
              await deleting.query("COMMIT");
              await work;
            } else {
              await fixture.query(`CREATE FUNCTION pause_test_object_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN IF NEW.role = 'object' THEN PERFORM pg_advisory_xact_lock(${BARRIER_KEY}::bigint); END IF; RETURN NEW; END $$`);
              await fixture.query(
                "CREATE TRIGGER pause_test_object_receipt BEFORE INSERT ON revision_receipts FOR EACH ROW EXECUTE FUNCTION pause_test_object_receipt()",
              );
              await barrier.query("BEGIN");
              await barrier.query("SELECT pg_advisory_xact_lock($1::bigint)", [
                BARRIER_KEY,
              ]);
              work = run();
              void work.catch(() => undefined);
              await waitsFor(fixture, recomputePid, barrierPid);
              removal = deleting.query("DELETE FROM objects WHERE id=$1", [
                pair.objectId,
              ]);
              void removal.catch(() => undefined);
              await waitsFor(fixture, deletingPid, recomputePid);
              await barrier.query("COMMIT");
              await Promise.all([work, removal]);
            }
            assert.deepEqual(await receiptRoles(fixture, pair.delivery.id), [
              "activity",
            ]);
            assert.equal(
              (
                await fixture.query("SELECT * FROM objects WHERE id=$1", [
                  pair.objectId,
                ])
              ).rows.length,
              0,
            );
            assert.deepEqual(
              (await loadResourceRevision(fixture.db, pair.revisions.object))
                ?.document,
              pair.objectDocument,
            );
          } finally {
            await barrier.query("ROLLBACK");
            await deleting.query("ROLLBACK");
            await Promise.allSettled([work, removal]);
            await recompute.close();
            await deleting.close();
            await barrier.close();
          }
        });
      },
    );
  }
}
