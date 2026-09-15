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

// oxlint-disable max-statements -- Keep upgrade before/after assertions together.
// Keep dependent database writes and observations sequential.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { migrate, relations, schema } from "@drfed/models";
import {
  PUBLIC_IRI,
  PUBLIC_RESOURCE_ID,
  ensureResource,
  promoteResource,
  storeAddressing,
} from "@drfed/models/resource";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as migrateBaseline } from "drizzle-orm/pglite/migrator";

it("reuses exact IRIs and promotes unknown resources atomically", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const iri = "https://remote.example/collection";
    const resource = await ensureResource(db, iri);
    assert.equal(resource.kind, "unknown");
    assert.equal((await ensureResource(db, iri)).id, resource.id);
    await assert.rejects(
      promoteResource(db, iri, "collection", () =>
        Promise.reject(new Error("abort")),
      ),
      /abort/u,
    );
    assert.equal((await ensureResource(db, iri)).kind, "unknown");
    await promoteResource(db, iri, "collection", async (tx, row) => {
      await tx
        .insert(schema.collections)
        .values({ id: row.id, type: "OrderedCollection" });
    });
    assert.equal((await ensureResource(db, iri)).kind, "collection");
    assert.equal(
      (await db.query.collections.findFirst({ where: { id: resource.id } }))
        ?.id,
      resource.id,
    );
    await assert.rejects(
      promoteResource(db, iri, "object", () =>
        Promise.reject(new Error("Unexpected incompatible insertion")),
      ),
      /already a collection/u,
    );
    assert.notEqual(
      (await ensureResource(db, "https://REMOTE.example/collection")).id,
      resource.id,
    );
    const source = await ensureResource(db, "https://example.com/source");
    await db.transaction(async (tx) => {
      await storeAddressing(tx, source.id, {
        to: [iri, PUBLIC_IRI, iri],
        cc: [iri],
        bto: [iri],
        bcc: [iri],
        audience: [iri],
      });
    });
    const rows = await db.query.addressing.findMany({
      where: { sourceId: source.id, property: "to" },
      orderBy: { position: "asc" },
    });
    assert.deepEqual(
      rows.map((r) => [r.position, r.targetId]),
      [
        [0, resource.id],
        [1, PUBLIC_RESOURCE_ID],
        [2, resource.id],
      ],
    );
    await assert.rejects(
      db.delete(schema.resources).where(eq(schema.resources.id, resource.id)),
    );
  } finally {
    await client.close();
  }
});

const migrationName = "20260915095905_add_resources_addressing_and_activities";
const migrations = join(
  dirname(fileURLToPath(import.meta.resolve("@drfed/models/migrate"))),
  "..",
  "drizzle",
);

it("backfills resources, actor collections, addressing and independent Create activities", async () => {
  const baseline = await mkdtemp(join(tmpdir(), "drfed-addressing-migration-"));
  const client = new PGlite();
  try {
    const entries = await readdir(migrations, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && e.name < migrationName)
        .map((e) =>
          cp(join(migrations, e.name), join(baseline, e.name), {
            recursive: true,
          }),
        ),
    );
    await migrateBaseline(drizzle({ client }), { migrationsFolder: baseline });
    const instanceId = uuidV7();
    const actorId = uuidV7();
    const iri = `https://old.example/users/${actorId}`;
    await client.query("INSERT INTO instances (id, host) VALUES ($1, $2)", [
      instanceId,
      "old.example",
    ]);
    await client.query(
      'INSERT INTO actors (id, "instanceId", type, username, iri, "inboxUrl", "outboxUrl", "followersUrl", "followingUrl", "featuredUrl") VALUES ($1, $2, \'Person\', \'old\', $3, $4, $5, $6, $7, $8)',
      [
        actorId,
        instanceId,
        iri,
        `${iri}/inbox`,
        `${iri}/outbox`,
        `${iri}/followers`,
        `${iri}/following`,
        `${iri}/featured`,
      ],
    );
    const ids = [uuidV7(), uuidV7(), uuidV7()];
    for (const [index, label] of [
      "public",
      "unlisted",
      "followers",
    ].entries()) {
      // Historical column names are restricted to the upgrade fixture.
      await client.query(
        "INSERT INTO objects (id, \"actorId\", type, iri, visibility, \"contentHtml\") VALUES ($1, $2, 'Note', $3, $4, 'old content')",
        [ids[index], actorId, `${iri}/${ids[index]}`, label],
      );
    }
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    assert.equal(await db.$count(schema.resources), 12);
    assert.equal(await db.$count(schema.collections), 5);
    assert.equal(await db.$count(schema.activities), 3);
    assert.equal(await db.$count(schema.addressing), 10);
    const followers = await db.query.collections.findFirst({
      where: { ownerActorId: actorId, role: "followers" },
      with: { resource: true },
    });
    assert.equal(followers?.resource.iri, `${iri}/followers`);
    for (const [index, id] of ids.entries()) {
      const object = await db.query.objects.findFirst({
        where: { id },
        with: {
          resource: true,
          addressing: { orderBy: { property: "asc", position: "asc" } },
          createActivity: {
            with: {
              resource: true,
              addressing: { orderBy: { property: "asc", position: "asc" } },
            },
          },
        },
      });
      assert.ok(object?.createActivity);
      assert.equal(object.resource.iri, `${iri}/${id}`);
      const activity = object.createActivity;
      assert.notEqual(activity.id, id);
      assert.equal(
        activity.resource.iri,
        `https://old.example/ap/creates/${id}`,
      );
      assert.equal(
        activity.published.epochNanoseconds,
        object.published.epochNanoseconds,
      );
      const targets = (rows: typeof object.addressing) =>
        rows.map((r) => [r.property, r.position, r.targetId]);
      assert.deepEqual(
        targets(activity.addressing),
        targets(object.addressing),
      );
      const expected: unknown =
        index === 0
          ? [
              ["to", 0, PUBLIC_RESOURCE_ID],
              ["cc", 0, followers?.id],
            ]
          : index === 1
            ? [
                ["to", 0, followers?.id],
                ["cc", 0, PUBLIC_RESOURCE_ID],
              ]
            : [["to", 0, followers?.id]];
      assert.deepEqual(targets(object.addressing), expected);
    }
    await migrate({ credentials: { driver: "pglite", client } });
    assert.equal(await db.$count(schema.activities), 3);
  } finally {
    await client.close();
    await rm(baseline, { recursive: true, force: true });
  }
});

it("reuses existing addressing targets without updating or locking their resource rows", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const source = await ensureResource(db, "https://example.com/source");
    await client.exec(`
      CREATE FUNCTION reject_resource_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'existing resource must not be updated'; END $$;
      CREATE TRIGGER no_resource_update BEFORE UPDATE ON resources
      FOR EACH ROW EXECUTE FUNCTION reject_resource_update();
    `);
    assert.equal((await ensureResource(db, PUBLIC_IRI)).id, PUBLIC_RESOURCE_ID);
    await db.transaction(async (tx) => {
      await storeAddressing(tx, source.id, { to: [PUBLIC_IRI, PUBLIC_IRI] });
    });
    assert.equal(await db.$count(schema.addressing), 2);
  } finally {
    await client.close();
  }
});

it("upgrades shared collection IRIs without dropping actor roles or addressing", async () => {
  const baseline = await mkdtemp(join(tmpdir(), "drfed-shared-collections-"));
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
    const instanceId = uuidV7();
    const alice = uuidV7();
    const bob = uuidV7();
    const shared = "https://old.example/shared";
    await client.query(
      "INSERT INTO instances (id, host) VALUES ($1, 'old.example')",
      [instanceId],
    );
    for (const [id, username, followers, featured] of [
      [alice, "alice", shared, shared],
      [bob, "bob", PUBLIC_IRI, null],
    ] as const) {
      await client.query(
        'INSERT INTO actors (id, "instanceId", type, username, iri, "inboxUrl", "outboxUrl", "followersUrl", "featuredUrl") VALUES ($1,$2,\'Person\',$3,$4,$5,$6,$7,$8)',
        [
          id,
          instanceId,
          username,
          `https://old.example/${username}`,
          `https://old.example/${username}/inbox`,
          shared,
          followers,
          featured,
        ],
      );
      await client.query(
        "INSERT INTO objects (id, \"actorId\", type, iri, visibility, \"contentHtml\") VALUES ($1,$2,'Note',$3,'followers','hello')",
        [uuidV7(), id, `https://old.example/${username}/note`],
      );
    }
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    assert.equal(await db.$count(schema.collections), 2);
    const collection = await db.query.collections.findFirst({
      where: { resource: { iri: shared } },
    });
    assert.ok(collection);
    assert.equal(collection.ownerActorId, null);
    assert.equal(collection.role, null);
    const refs = await db.query.actorCollectionReferences.findMany({
      with: { collection: { with: { resource: true } } },
      orderBy: { actorId: "asc", role: "asc" },
    });
    assert.equal(refs.length, 5);
    for (const [actorId, role, iri] of [
      [alice, "outbox", shared],
      [alice, "featured", shared],
      [alice, "followers", shared],
      [bob, "outbox", shared],
      [bob, "followers", PUBLIC_IRI],
    ] as const) {
      assert.equal(
        refs.find((ref) => ref.actorId === actorId && ref.role === role)
          ?.collection.resource.iri,
        iri,
      );
    }
    for (const [actorId, iri] of [
      [alice, shared],
      [bob, PUBLIC_IRI],
    ] as const) {
      const object = await db.query.objects.findFirst({
        where: { actorId },
        with: {
          addressing: { with: { targetResource: true } },
          createActivity: {
            with: { addressing: { with: { targetResource: true } } },
          },
        },
      });
      assert.ok(object?.createActivity);
      assert.deepEqual(
        object.addressing.map((entry) => [
          entry.property,
          entry.targetResource.iri,
        ]),
        [["to", iri]],
      );
      assert.deepEqual(
        object.createActivity.addressing.map((entry) => [
          entry.property,
          entry.targetResource.iri,
        ]),
        [["to", iri]],
      );
    }
  } finally {
    await client.close();
    await rm(baseline, { recursive: true, force: true });
  }
});
