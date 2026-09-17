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
// Keep the upgrade scenario and ordered writes together.
// oxlint-disable max-statements, no-await-in-loop
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { migrate, relations, schema } from "@drfed/models";
import {
  addActorCollectionItem,
  promoteResource,
} from "@drfed/models/resource";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as migrateBaseline } from "drizzle-orm/pglite/migrator";

const migrationName = "20260917163517_order_local_outbox_items";
const migrations = join(
  dirname(fileURLToPath(import.meta.resolve("@drfed/models/migrate"))),
  "..",
  "drizzle",
);

it("backfills local outbox chronology and preserves other collection positions", async () => {
  const baseline = await mkdtemp(join(tmpdir(), "drfed-outbox-migration-"));
  const client = new PGlite();
  try {
    const entries = await readdir(migrations, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name < migrationName)
        .map((entry) =>
          cp(join(migrations, entry.name), join(baseline, entry.name), {
            recursive: true,
          }),
        ),
    );
    await migrateBaseline(drizzle({ client }), { migrationsFolder: baseline });
    const db = drizzle({ client, schema, relations });
    const instanceId = uuidV7();
    await db
      .insert(schema.instances)
      .values({ id: instanceId, host: "migration.example" });
    const actorId = uuidV7();
    const remoteId = uuidV7();
    await db.insert(schema.localActors).values({ id: actorId });
    for (const id of [actorId, remoteId]) {
      await promoteResource(
        db,
        `https://migration.example/actors/${id}`,
        "actor",
        async (tx, row) => {
          await tx.insert(schema.actors).values({
            id: row.id,
            localId: id === actorId ? id : null,
            instanceId,
            type: "Person",
            username: id,
            inboxUrl: `https://migration.example/actors/${id}/inbox`,
          });
        },
        id,
      );
    }
    const outboxId = uuidV7();
    const remoteOutboxId = uuidV7();
    const featuredId = uuidV7();
    for (const [id, ownerActorId, role] of [
      [outboxId, actorId, "outbox"],
      [remoteOutboxId, remoteId, "outbox"],
      [featuredId, actorId, "featured"],
    ] as const) {
      await promoteResource(
        db,
        `https://migration.example/collections/${id}`,
        "collection",
        async (tx, row) => {
          await tx
            .insert(schema.collections)
            .values({ id: row.id, ownerActorId, type: "OrderedCollection" });
          await tx
            .insert(schema.actorCollectionReferences)
            .values({ actorId: ownerActorId, role, collectionId: row.id });
        },
        id,
      );
    }
    const ids = [uuidV7(), uuidV7(), uuidV7()] as const;
    for (const [index, id] of ids.entries()) {
      await promoteResource(
        db,
        `https://migration.example/activities/${id}`,
        "activity",
        async (tx, row) => {
          await tx.insert(schema.activities).values({
            id: row.id,
            actorId,
            type: "Create",
            published: Temporal.Instant.from(
              index === 0 ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z",
            ),
          });
        },
        id,
      );
      await db.insert(schema.collectionItems).values([
        {
          collectionId: outboxId,
          itemId: id,
          position: index === 0 ? -99 : null,
        },
        { collectionId: remoteOutboxId, itemId: id, position: null },
        { collectionId: featuredId, itemId: id, position: index },
      ]);
    }
    const otherItems = await db.query.collectionItems.findMany({
      where: { collectionId: { ne: outboxId } },
      orderBy: { collectionId: "asc", itemId: "asc" },
    });
    await migrate({ credentials: { driver: "pglite", client } });
    const ordered = await db.query.collectionItems.findMany({
      where: { collectionId: outboxId },
      columns: { itemId: true, position: true },
      orderBy: { position: "asc" },
    });
    assert.deepEqual(ordered, [
      { itemId: ids[2], position: -3 },
      { itemId: ids[1], position: -2 },
      { itemId: ids[0], position: -1 },
    ]);
    assert.deepEqual(
      await db.query.collectionItems.findMany({
        where: { collectionId: { ne: outboxId } },
        orderBy: { collectionId: "asc", itemId: "asc" },
      }),
      otherItems,
    );
    const newest = uuidV7();
    await promoteResource(
      db,
      `https://migration.example/activities/${newest}`,
      "activity",
      async (tx, row) => {
        await tx.insert(schema.activities).values({
          id: row.id,
          actorId,
          type: "Create",
          published: Temporal.Instant.from("2026-01-03T00:00:00Z"),
        });
      },
      newest,
    );
    await addActorCollectionItem(db, actorId, "outbox", newest);
    await migrate({ credentials: { driver: "pglite", client } });
    assert.deepEqual(
      await db.query.collectionItems.findMany({
        where: { collectionId: outboxId },
        columns: { itemId: true, position: true },
        orderBy: { position: "asc" },
      }),
      [{ itemId: newest, position: -4 }, ...ordered],
    );
  } finally {
    await client.close();
    await rm(baseline, { recursive: true, force: true });
  }
});
