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

// Writes in one test depend on the state left by the previous ones.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";
import { it } from "node:test";

import {
  type AddressingOccurrence,
  ensureResource,
  storeAddressing,
} from "@drfed/models/resource";
import {
  LegacyResourceRevisionError,
  ResourceRevisionStateError,
  RevisionConflictError,
  type TypedResourceRevisionInput,
  appendResourceRevision,
  captureLegacyResourceRevision,
  listResourceRevisions,
  loadCurrentResourceRevision,
  writeTypedResourceRevision,
} from "@drfed/models/resource-revision";
import { uuidV7 } from "@drfed/models/uuid";

import {
  type RevisionFixture,
  revisionBackends,
  revisionConnection,
  revisionPostgresUrl,
  withRevisionDatabase,
} from "./resource-revision-fixture.ts";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

/**
 * Creates a typed Note captured as legacy creation does, with root addressing.
 * @returns Its IDs, IRI, first revision, and document.
 */
async function typedNote(fixture: RevisionFixture) {
  const instanceId = uuidV7();
  const actorId = uuidV7();
  const objectId = uuidV7();
  const iri = `https://typed.example/objects/${objectId}`;
  const document = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: iri,
    type: "Note",
    content: "first",
    to: [PUBLIC],
    bcc: ["https://typed.example/blind"],
  };
  await fixture.query("INSERT INTO instances (id, host) VALUES ($1, $2)", [
    instanceId,
    `${instanceId}.example`,
  ]);
  await fixture.query(
    "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, 'actor'), ($3, $4, 'object')",
    [actorId, `https://typed.example/actors/${actorId}`, objectId, iri],
  );
  await fixture.query(
    "INSERT INTO actors (id, type, instance_id, inbox_url) VALUES ($1, 'Person', $2, 'https://typed.example/inbox')",
    [actorId, instanceId],
  );
  await fixture.query(
    "INSERT INTO objects (id, actor_id, type, content_html, document) VALUES ($1, $2, 'Note', 'first', $3::json)",
    [objectId, actorId, JSON.stringify(document)],
  );
  const revisionId = await fixture.db.transaction(async (tx) => {
    await storeAddressing(tx, objectId, {
      to: [PUBLIC],
      bcc: ["https://typed.example/blind"],
    });
    return await captureLegacyResourceRevision(tx, objectId);
  });
  return { objectId, iri, revisionId, document };
}

async function currentAddressing(fixture: RevisionFixture, id: string) {
  const { rows } = await fixture.query<{
    property: string;
    position: number;
    iri: string;
  }>(
    "SELECT a.property::text AS property, a.position, r.iri FROM addressing a JOIN resources r ON r.id = a.target_id WHERE a.source_id = $1 ORDER BY a.property, a.position",
    [id],
  );
  return rows.map(({ property, position, iri }) => ({
    property,
    position: Number(position),
    iri,
  }));
}

async function typedRow(fixture: RevisionFixture, id: string) {
  const { rows } = await fixture.query<{
    content_html: string;
    name: string | null;
    sensitive: boolean;
    document: string;
    deleted: unknown;
    updated: unknown;
  }>(
    "SELECT content_html, name, sensitive, document::text AS document, deleted, to_char(updated AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') AS updated FROM objects WHERE id = $1",
    [id],
  );
  return rows[0];
}

function edit(
  objectId: string,
  expectedRevisionId: string,
  content: string,
  addressingOccurrences: readonly AddressingOccurrence[],
): TypedResourceRevisionInput {
  const updated = Temporal.Instant.from("2026-11-02T00:00:00.123456Z");
  return {
    resourceId: objectId as never,
    expectedRevisionId: expectedRevisionId as never,
    kind: "snapshot",
    document: { type: "Note", content, name: "Named" },
    columns: {
      url: null,
      name: "Named",
      summary: null,
      contentHtml: content,
      language: null,
      sensitive: true,
      published: Temporal.Instant.from("2026-11-01T00:00:00Z"),
      updated,
    },
    addressingOccurrences,
  };
}

for (const backend of revisionBackends) {
  const options = { skip: backend === "postgres" && !revisionPostgresUrl };

  it(
    `edits and deletes a typed object in step with its history on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const { objectId, revisionId } = await typedNote(fixture);
        const occurrences: AddressingOccurrence[] = [
          { property: "to", position: 0, iri: PUBLIC },
          // Position 1 held an anonymous value and stays unused.
          { property: "to", position: 2, iri: "https://typed.example/bob" },
          { property: "bto", position: 0, iri: "https://typed.example/blind" },
        ];
        const second = await writeTypedResourceRevision(
          fixture.db,
          edit(objectId, revisionId, "second", occurrences),
        );
        assert.equal(second.sequence, 2);
        assert.equal(second.capture, "local");
        assert.deepEqual(
          second.addressing.map(({ property, position, iri }) => ({
            property,
            position,
            iri,
          })),
          [
            { property: "to", position: 0, iri: PUBLIC },
            { property: "to", position: 2, iri: "https://typed.example/bob" },
            {
              property: "bto",
              position: 0,
              iri: "https://typed.example/blind",
            },
          ],
        );
        const row = await typedRow(fixture, objectId);
        assert.equal(row?.content_html, "second");
        assert.equal(row?.name, "Named");
        assert.equal(row?.sensitive, true);
        assert.equal(row?.updated, "2026-11-02T00:00:00.123456");
        assert.equal(
          row?.document,
          JSON.stringify({ type: "Note", content: "second", name: "Named" }),
        );
        assert.deepEqual(await currentAddressing(fixture, objectId), [
          { property: "to", position: 0, iri: PUBLIC },
          { property: "to", position: 2, iri: "https://typed.example/bob" },
          { property: "bto", position: 0, iri: "https://typed.example/blind" },
        ]);

        const deleted = Temporal.Instant.from("2026-11-03T00:00:00Z");
        const whiteout = await writeTypedResourceRevision(fixture.db, {
          resourceId: objectId as never,
          expectedRevisionId: second.id,
          kind: "whiteout",
          deleted,
          formerTypes: ["Note"],
        });
        assert.equal(whiteout.kind, "whiteout");
        assert.equal(whiteout.addressing.length, 3);
        const removed = await typedRow(fixture, objectId);
        assert.notEqual(removed?.deleted, null);
        assert.equal(removed?.updated, "2026-11-02T00:00:00.123456");
        assert.equal(removed?.content_html, "second");
        // The last content's recipients still describe the deleted object.
        assert.equal((await currentAddressing(fixture, objectId)).length, 3);
        assert.deepEqual(
          (await listResourceRevisions(fixture.db, objectId as never)).map(
            ({ sequence, kind }) => [sequence, kind],
          ),
          [
            [3, "whiteout"],
            [2, "snapshot"],
            [1, "snapshot"],
          ],
        );
        await assert.rejects(
          writeTypedResourceRevision(
            fixture.db,
            edit(objectId, whiteout.id, "revived", []),
          ),
          (error: unknown) =>
            error instanceof ResourceRevisionStateError &&
            error.code === "deleted",
        );
      });
    },
  );

  it(
    `refuses stale, drifted, and untyped objects without changes on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const { objectId, revisionId, document } = await typedNote(fixture);
        const before = await typedRow(fixture, objectId);
        await assert.rejects(
          writeTypedResourceRevision(
            fixture.db,
            edit(objectId, uuidV7(), "stale", []),
          ),
          (error: unknown) =>
            error instanceof RevisionConflictError &&
            error.actualRevisionId === revisionId,
        );
        // A typed document rewritten outside the history is drift.
        await fixture.query(
          "UPDATE objects SET document = $2::json WHERE id = $1",
          [objectId, JSON.stringify({ ...document, content: "drifted" })],
        );
        await assert.rejects(
          writeTypedResourceRevision(
            fixture.db,
            edit(objectId, revisionId, "second", []),
          ),
          LegacyResourceRevisionError,
        );
        await fixture.query(
          "UPDATE objects SET document = $2::json WHERE id = $1",
          [objectId, JSON.stringify(document)],
        );
        // So is current addressing that no longer matches the history.
        await fixture.query(
          "DELETE FROM addressing WHERE source_id = $1 AND property = 'bcc'",
          [objectId],
        );
        await assert.rejects(
          writeTypedResourceRevision(
            fixture.db,
            edit(objectId, revisionId, "second", []),
          ),
          LegacyResourceRevisionError,
        );
        assert.deepEqual(await typedRow(fixture, objectId), {
          ...before,
          updated: (await typedRow(fixture, objectId))?.updated,
        });
        assert.equal(
          (await loadCurrentResourceRevision(fixture.db, objectId as never))
            ?.id,
          revisionId,
        );

        const untyped = await ensureResource(
          fixture.db,
          `https://typed.example/untyped/${uuidV7()}`,
        );
        const head = await appendResourceRevision(fixture.db, {
          resourceId: untyped.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { type: "Note", content: "revision only" },
          capture: "local",
        });
        await assert.rejects(
          writeTypedResourceRevision(
            fixture.db,
            edit(untyped.id, head.id, "typed", []),
          ),
          LegacyResourceRevisionError,
        );
      });
    },
  );

  it(
    `rolls back a typed write whose append fails, inside a caught savepoint on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const { objectId, revisionId } = await typedNote(fixture);
        const before = await typedRow(fixture, objectId);
        const addressingBefore = await currentAddressing(fixture, objectId);
        // Fail the revision insertion, after the typed row has been changed.
        await fixture.query(`CREATE FUNCTION test_explode() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN
          IF NEW.document::text LIKE '%explode%' THEN
            RAISE EXCEPTION 'explode';
          END IF;
          RETURN NEW;
        END; $$`);
        await fixture.query(`CREATE TRIGGER test_explode BEFORE INSERT ON resource_revisions
        FOR EACH ROW EXECUTE FUNCTION test_explode()`);
        await fixture.db.transaction(async (tx) => {
          await assert.rejects(
            writeTypedResourceRevision(
              tx,
              edit(objectId, revisionId, "explode", [
                {
                  property: "cc",
                  position: 0,
                  iri: "https://typed.example/new",
                },
              ]),
            ),
          );
          // The outer transaction continues without any part of the write.
          const [row] = await tx.query.objects.findMany({
            columns: { contentHtml: true },
            where: { id: objectId as never },
          });
          assert.equal(row?.contentHtml, "first");
        });
        assert.deepEqual(await typedRow(fixture, objectId), before);
        assert.deepEqual(
          await currentAddressing(fixture, objectId),
          addressingBefore,
        );
        assert.equal(
          (await listResourceRevisions(fixture.db, objectId as never)).length,
          1,
        );
      });
    },
  );

  it(
    `stores addressing occurrences at their source positions on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const resource = await ensureResource(
          fixture.db,
          `https://typed.example/positions/${uuidV7()}`,
        );
        const revision = await appendResourceRevision(fixture.db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { type: "Note" },
          capture: "local",
          addressingOccurrences: [
            { property: "cc", position: 3, iri: "https://typed.example/late" },
            { property: "to", position: 1, iri: PUBLIC },
          ],
        });
        assert.deepEqual(
          revision.addressing.map(({ property, position }) => [
            property,
            position,
          ]),
          [
            ["to", 1],
            ["cc", 3],
          ],
        );
        for (const addressingOccurrences of [
          [
            { property: "to", position: 0, iri: PUBLIC },
            { property: "to", position: 0, iri: PUBLIC },
          ],
          [{ property: "to", position: -1, iri: PUBLIC }],
          [{ property: "to", position: 2_147_483_648, iri: PUBLIC }],
          [{ property: "from", position: 0, iri: PUBLIC }],
        ] as AddressingOccurrence[][]) {
          await assert.rejects(
            appendResourceRevision(fixture.db, {
              resourceId: resource.id,
              resourceKind: "object",
              expectedRevisionId: revision.id,
              kind: "snapshot",
              document: { type: "Note" },
              capture: "local",
              addressingOccurrences,
            }),
            TypeError,
          );
        }
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: resource.id,
            resourceKind: "object",
            expectedRevisionId: revision.id,
            kind: "snapshot",
            document: { type: "Note" },
            capture: "local",
            addressing: { to: [PUBLIC] },
            addressingOccurrences: [],
          }),
          TypeError,
        );
      });
    },
  );
}

it(
  "lets only one of two concurrent typed edits of one head win on PostgreSQL",
  { skip: !revisionPostgresUrl },
  async () => {
    await withRevisionDatabase("postgres", async (fixture) => {
      assert.ok(fixture.url);
      const { objectId, revisionId } = await typedNote(fixture);
      const one = revisionConnection(fixture.url);
      const two = revisionConnection(fixture.url);
      try {
        const results = await Promise.allSettled(
          [one, two].map((connection, index) =>
            writeTypedResourceRevision(
              connection.db,
              edit(objectId, revisionId, `edit-${index}`, []),
            ),
          ),
        );
        const won = results.find((result) => result.status === "fulfilled");
        const lost = results.find((result) => result.status === "rejected");
        assert.ok(won?.status === "fulfilled");
        assert.ok(lost?.status === "rejected");
        assert.ok(lost.reason instanceof RevisionConflictError);
        assert.equal(lost.reason.actualRevisionId, won.value.id);
        const row = await typedRow(fixture, objectId);
        assert.equal(row?.document, JSON.stringify(won.value.document));
      } finally {
        await one.close();
        await two.close();
      }
    });
  },
);
