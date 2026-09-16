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

// oxlint-disable max-statements -- Keep resource before/after assertions together.

import assert from "node:assert/strict";
import { it } from "node:test";

import { migrate, relations, schema } from "@drfed/models";
import {
  PUBLIC_IRI,
  PUBLIC_RESOURCE_ID,
  ensureResource,
  promoteResource,
  storeAddressing,
} from "@drfed/models/resource";
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
