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
// oxlint-disable no-await-in-loop
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
    await client.query("INSERT INTO instances (id, host) VALUES ($1, $2)", [
      instanceId,
      "migration.example",
    ]);
    const actorId = uuidV7();
    const remoteId = uuidV7();
    await client.query("INSERT INTO local_actors (id) VALUES ($1)", [actorId]);
    for (const id of [actorId, remoteId]) {
      await client.query(
        "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, 'actor')",
        [id, `https://migration.example/actors/${id}`],
      );
      await client.query(
        `INSERT INTO actors (id, "localId", "instanceId", type, username, "inboxUrl") VALUES ($1, $2, $3, 'Person', $4, $5)`,
        [
          id,
          id === actorId ? id : null,
          instanceId,
          id,
          `https://migration.example/actors/${id}/inbox`,
        ],
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
      await client.query(
        "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, 'collection')",
        [id, `https://migration.example/collections/${id}`],
      );
      await client.query(
        `INSERT INTO collections (id, "ownerActorId", type) VALUES ($1, $2, 'OrderedCollection')`,
        [id, ownerActorId],
      );
      await client.query(
        'INSERT INTO actor_collection_references ("actorId", role, "collectionId") VALUES ($1, $2, $3)',
        [ownerActorId, role, id],
      );
    }
    const ids = [uuidV7(), uuidV7(), uuidV7()] as const;
    for (const [index, id] of ids.entries()) {
      await client.query(
        "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, 'activity')",
        [id, `https://migration.example/activities/${id}`],
      );
      await client.query(
        `INSERT INTO activities (id, "actorId", type, published) VALUES ($1, $2, 'Create', $3)`,
        [
          id,
          actorId,
          index === 0 ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z",
        ],
      );
      await client.query(
        'INSERT INTO collection_items ("collectionId", "itemId", position) VALUES ($1, $4, $5), ($2, $4, NULL), ($3, $4, $6)',
        [
          outboxId,
          remoteOutboxId,
          featuredId,
          id,
          index === 0 ? -99 : null,
          index,
        ],
      );
    }
    const otherItems = (
      await client.query(
        'SELECT "collectionId" AS collection_id, "itemId" AS item_id, position, observed FROM collection_items WHERE "collectionId" <> $1 ORDER BY "collectionId", "itemId"',
        [outboxId],
      )
    ).rows;
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
      (
        await client.query(
          "SELECT * FROM collection_items WHERE collection_id <> $1 ORDER BY collection_id, item_id",
          [outboxId],
        )
      ).rows,
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
