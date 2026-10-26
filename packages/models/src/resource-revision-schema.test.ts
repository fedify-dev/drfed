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

import { schema } from "@drfed/models";
import { uuidV7 } from "@drfed/models/uuid";
import { eq } from "drizzle-orm";

import {
  type RevisionFixture,
  revisionBackends,
  revisionPostgresUrl,
  withRevisionDatabase,
} from "./resource-revision-fixture.ts";

async function resource(fixture: RevisionFixture, kind = "object") {
  const id = uuidV7();
  await fixture.query(
    "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, $3::resource_kind)",
    [id, `https://example.test/resources/${id}`, kind],
  );
  return id;
}

async function snapshot(
  fixture: RevisionFixture,
  resourceId: string,
  sequence: number,
  document = '{"type":"Note","content":"A"}',
) {
  const id = uuidV7();
  await fixture.query(
    `INSERT INTO resource_revisions
      (id, resource_id, sequence, kind, capture, document, projection)
     VALUES ($1, $2, $3::integer, 'snapshot', 'local', $4::json, 'partial')`,
    [id, resourceId, String(sequence), document],
  );
  return id;
}

async function publish(
  fixture: RevisionFixture,
  resourceId: string,
  id: string,
) {
  await fixture.query(
    `INSERT INTO resource_heads (resource_id, revision_id) VALUES ($1, $2)
     ON CONFLICT (resource_id) DO UPDATE SET revision_id = excluded.revision_id`,
    [resourceId, id],
  );
}

async function rollsBack(
  fixture: RevisionFixture,
  run: () => Promise<unknown>,
) {
  await fixture.query("BEGIN");
  try {
    await assert.rejects(run);
  } finally {
    await fixture.query("ROLLBACK");
  }
}

for (const backend of revisionBackends) {
  it(
    `seals immutable history and projections on ${backend}`,
    {
      skip: backend === "postgres" && !revisionPostgresUrl,
    },
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const id = await resource(fixture);
        await fixture.query("BEGIN");
        const first = await snapshot(fixture, id, 1);
        await fixture.query(
          `INSERT INTO revision_addressing (revision_id, property, position, iri)
         VALUES ($1, 'to', 0, 'urn:recipient'), ($1, 'to', 1, 'urn:recipient'),
                ($1, 'bcc', 0, 'urn:blind')`,
          [first],
        );
        await fixture.query(
          `INSERT INTO revision_relations
          (revision_id, occurrence, property, path, representation, target_iri)
         VALUES ($1, 0, 'https://www.w3.org/ns/activitystreams#object',
                 '["object",0]'::json, 'reference', 'urn:unresolved')`,
          [first],
        );
        await publish(fixture, id, first);
        await fixture.query("COMMIT");
        assert.equal(
          (
            await fixture.db.query.resourceHeads.findFirst({
              where: { resourceId: id as ReturnType<typeof uuidV7> },
            })
          )?.revisionId,
          first,
        );
        assert.equal(
          (await fixture.query("SELECT * FROM revision_addressing")).rows
            .length,
          3,
        );
        assert.equal(
          (
            await fixture.query(
              "SELECT * FROM resources WHERE iri='urn:unresolved'",
            )
          ).rows.length,
          0,
        );
        for (const statement of [
          "UPDATE resource_revisions SET document='{}'::json WHERE id=$1",
          "DELETE FROM resource_revisions WHERE id=$1",
          "UPDATE revision_addressing SET iri='urn:changed' WHERE revision_id=$1",
          "DELETE FROM revision_addressing WHERE revision_id=$1",
          "UPDATE revision_relations SET target_iri='urn:changed' WHERE revision_id=$1",
          "DELETE FROM revision_relations WHERE revision_id=$1",
          "INSERT INTO revision_addressing (revision_id, property, position, iri) VALUES ($1, 'cc', 0, 'urn:late')",
          "INSERT INTO revision_relations (revision_id, occurrence, property, representation, target_iri) VALUES ($1, 1, 'object', 'reference', 'urn:late')",
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          await assert.rejects(fixture.query(statement, [first]));
        }
        await assert.rejects(
          fixture.query("DELETE FROM resource_heads WHERE resource_id=$1", [
            id,
          ]),
        );
        await assert.rejects(
          fixture.db
            .delete(schema.resources)
            .where(eq(schema.resources.id, id as ReturnType<typeof uuidV7>)),
        );
        for (const table of [
          "resource_revisions",
          "resource_heads",
          "revision_addressing",
          "revision_relations",
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          await assert.rejects(fixture.query(`TRUNCATE ${table} CASCADE`));
        }
        await rollsBack(fixture, async () => {
          await snapshot(fixture, id, 2);
          await fixture.query("COMMIT");
        });
        assert.equal(
          (await fixture.query("SELECT * FROM resource_revisions")).rows.length,
          1,
        );
      });
    },
  );

  it(
    `commits content and whiteout before a final head on ${backend}`,
    {
      skip: backend === "postgres" && !revisionPostgresUrl,
    },
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const id = await resource(fixture);
        await fixture.query("BEGIN");
        const first = await snapshot(fixture, id, 1);
        const whiteout = uuidV7();
        await fixture.query(
          `INSERT INTO resource_revisions
          (id, resource_id, sequence, kind, capture, former_types, deleted, projection)
         VALUES ($1, $2, 2, 'whiteout', 'local', ARRAY['Note'], now(), 'partial')`,
          [whiteout, id],
        );
        await publish(fixture, id, whiteout);
        await fixture.query("SET CONSTRAINTS ALL IMMEDIATE");
        await fixture.query("COMMIT");
        const rows = (
          await fixture.query(
            "SELECT kind FROM resource_revisions WHERE resource_id=$1 ORDER BY sequence",
            [id],
          )
        ).rows;
        assert.deepEqual(
          rows.map((row) => row.kind),
          ["snapshot", "whiteout"],
        );
        await assert.rejects(
          fixture.query(
            "UPDATE resource_heads SET revision_id=$1 WHERE resource_id=$2",
            [first, id],
          ),
        );
        await rollsBack(fixture, () => snapshot(fixture, id, 3));
        await assert.rejects(
          fixture.query(
            "INSERT INTO revision_addressing (revision_id, property, position, iri) VALUES ($1, 'cc', 0, 'urn:late')",
            [first],
          ),
        );
      });
    },
  );

  it(
    `checks activity, missing-document, and head integrity on ${backend}`,
    {
      skip: backend === "postgres" && !revisionPostgresUrl,
    },
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const activity = await resource(fixture, "activity");
        await fixture.query("BEGIN");
        const first = await snapshot(fixture, activity, 1, '{"type":"Arrive"}');
        await publish(fixture, activity, first);
        await fixture.query("COMMIT");
        await rollsBack(fixture, () => snapshot(fixture, activity, 2));
        const other = await resource(fixture);
        await rollsBack(fixture, () =>
          fixture.query(
            "INSERT INTO resource_heads (resource_id, revision_id) VALUES ($1, $2)",
            [other, first],
          ),
        );
        await rollsBack(fixture, () =>
          fixture.query(
            `INSERT INTO resource_revisions (id, resource_id, sequence, kind, capture, former_types, deleted, projection)
         VALUES ($1, $2, 1, 'whiteout', 'local', ARRAY['Note'], now(), 'partial')`,
            [uuidV7(), other],
          ),
        );
        const unknown = await resource(fixture, "unknown");
        await rollsBack(fixture, () => snapshot(fixture, unknown, 1));
        await fixture.query("BEGIN");
        const literalNull = await snapshot(fixture, other, 1, "null");
        await publish(fixture, other, literalNull);
        await fixture.query("COMMIT");
        assert.deepEqual(
          (
            await fixture.query(
              "SELECT kind, document::text AS text FROM resource_revisions WHERE id=$1",
              [literalNull],
            )
          ).rows,
          [{ kind: "snapshot", text: "null" }],
        );
        const absent = await resource(fixture);
        const unavailable = uuidV7();
        await fixture.query("BEGIN");
        await fixture.query(
          `INSERT INTO resource_revisions (id, resource_id, sequence, kind, capture, projection)
         VALUES ($1, $2, 1, 'unavailable', 'embedded', 'partial')`,
          [unavailable, absent],
        );
        await publish(fixture, absent, unavailable);
        await fixture.query("COMMIT");
        assert.deepEqual(
          (
            await fixture.query(
              "SELECT kind, document::text AS text FROM resource_revisions WHERE id=$1",
              [unavailable],
            )
          ).rows,
          [{ kind: "unavailable", text: null }],
        );
      });
    },
  );
  it(
    `retains legacy activities when an unversioned target is removed on ${backend}`,
    {
      skip: backend === "postgres" && !revisionPostgresUrl,
    },
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const actorId = await resource(fixture, "actor");
        const instanceId = uuidV7();
        await fixture.query(
          "INSERT INTO instances (id, host) VALUES ($1, 'legacy.example')",
          [instanceId],
        );
        await fixture.query(
          "INSERT INTO actors (id, type, instance_id, inbox_url) VALUES ($1, 'Person', $2, 'https://legacy.example/inbox')",
          [actorId, instanceId],
        );
        const target = await resource(fixture, "unknown");
        const activity = await resource(fixture, "activity");
        const document = {
          type: "Create",
          object: `https://example.test/resources/${target}`,
        };
        await fixture.query(
          `INSERT INTO activities (id, type, actor_id, object_id, published, document)
         VALUES ($1, 'Create', $2, $3, now(), $4::json)`,
          [activity, actorId, target, JSON.stringify(document)],
        );
        await fixture.query("DELETE FROM resources WHERE id=$1", [target]);
        const row = await fixture.db.query.activities.findFirst({
          where: { id: activity },
          with: { object: true },
        });
        assert.ok(row);
        assert.equal(row.objectId, null);
        assert.equal(row.object, null);
        assert.deepEqual(row.document, document);
      });
    },
  );
}
