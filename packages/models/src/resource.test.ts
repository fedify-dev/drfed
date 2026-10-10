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

import { type Transaction, migrate, relations, schema } from "@drfed/models";
import {
  PUBLIC_IRI,
  PUBLIC_RESOURCE_ID,
  ResourceKindConflictError,
  addActorCollectionItem,
  ensureResource,
  promoteResource,
  storeAddressing,
} from "@drfed/models/resource";
import type { Resource } from "@drfed/models/schema";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

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

it("records idempotent collection membership only for declared roles", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const instanceId = "00000000-0000-4000-8000-000000000101";
    await db.insert(schema.instances).values({
      id: instanceId,
      host: "test-instance.drfed.org",
    });
    const actorIri = "https://test-instance.drfed.org/users/alice";
    const actor = await promoteResource(
      db,
      actorIri,
      "actor",
      async (tx, row) => {
        await tx.insert(schema.actors).values({
          id: row.id,
          instanceId,
          type: "Person",
          username: "alice",
          inboxUrl: `${actorIri}/inbox`,
        });
        return row;
      },
    );
    const outbox = await promoteResource(
      db,
      `${actorIri}/outbox`,
      "collection",
      async (tx, row) => {
        await tx.insert(schema.collections).values({
          id: row.id,
          type: "OrderedCollection",
          ownerActorId: actor.id,
        });
        await tx.insert(schema.actorCollectionReferences).values({
          actorId: actor.id,
          role: "outbox",
          collectionId: row.id,
        });
        return row;
      },
    );
    const item = await ensureResource(db, "https://remote.example/activity");
    await addActorCollectionItem(db, actor.id, "outbox", item.id);
    await addActorCollectionItem(db, actor.id, "outbox", item.id);
    assert.deepEqual(
      await db.query.collectionItems.findMany({
        columns: { collectionId: true, itemId: true, position: true },
      }),
      [{ collectionId: outbox.id, itemId: item.id, position: -1 }],
    );
    const newer = await ensureResource(db, "https://remote.example/newer");
    await addActorCollectionItem(db, actor.id, "outbox", newer.id);
    assert.deepEqual(
      await db.query.collectionItems.findMany({
        columns: { itemId: true, position: true },
        orderBy: { position: "asc" },
      }),
      [
        { itemId: newer.id, position: -2 },
        { itemId: item.id, position: -1 },
      ],
    );
    await assert.rejects(
      addActorCollectionItem(db, actor.id, "featured", item.id),
      /declares no featured collection/u,
    );
    assert.equal(await db.$count(schema.collectionItems), 2);
  } finally {
    await client.close();
  }
});

it("indexes activities by referenced object in connection order", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const { rows } = await client.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where tablename = 'activities'",
    );
    const definitions = rows.map((row) => row.indexdef);
    assert.ok(
      definitions.some((definition) =>
        /\(object_id, published, id\)$/u.test(definition),
      ),
      `No (object_id, published, id) index on activities:\n${definitions.join("\n")}`,
    );
  } finally {
    await client.close();
  }
});

it("reuses an IRI already of the kind under the lock, and refuses another kind", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const iri = "https://remote.example/collection";
    const insert = async (tx: Transaction, row: Resource) => {
      await tx
        .insert(schema.collections)
        .values({ id: row.id, type: "OrderedCollection" });
      return "inserted";
    };
    const reused: Resource[] = [];
    const reuse = (_tx: Transaction, row: Resource) => {
      reused.push(row);
      return Promise.resolve("reused");
    };
    assert.equal(
      await promoteResource(db, iri, "collection", insert, undefined, reuse),
      "inserted",
    );
    assert.equal(reused.length, 0);
    const before = await db.$count(schema.collections);
    assert.equal(
      await promoteResource(db, iri, "collection", insert, undefined, reuse),
      "reused",
    );
    assert.equal(reused[0]?.kind, "collection");
    assert.equal(await db.$count(schema.collections), before);
    // A caller that only ever promotes new IRIs is told it was not one.
    await assert.rejects(
      promoteResource(db, iri, "collection", insert),
      /already been promoted/u,
    );
    await assert.rejects(
      promoteResource(db, iri, "activity", insert, undefined, reuse),
      (error: unknown) =>
        error instanceof ResourceKindConflictError &&
        error.iri === iri &&
        error.kind === "collection" &&
        error.requested === "activity",
    );
    assert.equal(reused.length, 1);
  } finally {
    await client.close();
  }
});

it("keeps local actors' usernames unique handles, and remote ones as received", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, schema, relations });
    const local = uuidV7();
    const remote = uuidV7();
    await db.insert(schema.instances).values([
      { id: local, host: "local.example" },
      { id: remote, host: "remote.example" },
    ]);
    const insertActor = (
      iri: string,
      values: Omit<
        typeof schema.actors.$inferInsert,
        "id" | "type" | "inboxUrl"
      >,
    ) =>
      promoteResource(db, iri, "actor", async (tx, row) => {
        await tx
          .insert(schema.actors)
          .values({ ...values, id: row.id, type: "Person", inboxUrl: iri });
      });
    // Remote actors share or lack a preferredUsername, and may use `@`.
    await insertActor("https://remote.example/users/alice", {
      instanceId: remote,
      username: "alice",
    });
    await insertActor("https://remote.example/bots/alice", {
      instanceId: remote,
      username: "alice",
    });
    await insertActor("https://remote.example/users/anonymous", {
      instanceId: remote,
      username: null,
    });
    await insertActor("https://remote.example/users/at", {
      instanceId: remote,
      username: "a@b",
    });
    assert.equal(await db.$count(schema.actors), 4);
    const localIds = [uuidV7(), uuidV7(), uuidV7(), uuidV7()] as const;
    await db.insert(schema.localActors).values(localIds.map((id) => ({ id })));
    await insertActor("https://local.example/users/1", {
      instanceId: local,
      localId: localIds[0],
      username: "alice",
    });
    for (const [iri, values, pattern] of [
      [
        "https://local.example/users/2",
        { localId: localIds[1], username: "alice" },
        /username_key/u,
      ],
      [
        "https://local.example/users/3",
        { localId: localIds[2], username: "a@b" },
        /actors_username_check/u,
      ],
      [
        "https://local.example/users/4",
        { localId: localIds[3], username: null },
        /actors_local_username_check/u,
      ],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await assert.rejects(
        insertActor(iri, { ...values, instanceId: local }),
        (error: unknown) =>
          error instanceof Error &&
          pattern.test(String((error.cause as Error | undefined)?.message)),
      );
    }
    assert.equal(await db.$count(schema.actors), 5);
  } finally {
    await client.close();
  }
});
