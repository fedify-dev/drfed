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

import { ensureResource, storeAddressing } from "@drfed/models/resource";
import {
  type RevisionEmbeddingInput,
  appendResourceRevision,
  captureLegacyResourceRevision,
  loadCurrentResourceRevision,
  writeTypedResourceRevision,
} from "@drfed/models/resource-revision";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";

import {
  type RevisionFixture,
  revisionBackends,
  revisionPostgresUrl,
  withRevisionDatabase,
} from "./resource-revision-fixture.ts";

const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";

async function snapshot(
  fixture: RevisionFixture,
  document: Record<string, string>,
  embeddings?: readonly RevisionEmbeddingInput[],
) {
  const resource = await ensureResource(
    fixture.db,
    `https://example.test/resources/${uuidV7()}`,
  );
  const revision = await appendResourceRevision(fixture.db, {
    resourceId: resource.id,
    resourceKind: "object",
    expectedRevisionId: null,
    kind: "snapshot",
    document,
    capture: "local",
    ...(embeddings === undefined ? {} : { embeddings }),
  });
  return { resource, revision };
}

async function embeddingRows(fixture: RevisionFixture, revisionId: string) {
  const { rows } = await fixture.query<{
    path: string;
    source_revision_id: string;
    relation: string;
  }>(
    "SELECT path::text AS path, source_revision_id, relation::text AS relation FROM revision_embeddings WHERE revision_id = $1 ORDER BY path::text",
    [revisionId],
  );
  return rows.map(({ path, source_revision_id, relation }) => ({
    path: JSON.parse(path) as unknown,
    sourceRevisionId: source_revision_id,
    relation,
  }));
}

// Drivers wrap database errors; the constraint name may sit on a cause.
function constraintOf(error: unknown): string | undefined {
  let detail: unknown = error;
  while (detail instanceof Error) {
    for (const key of ["constraint", "constraint_name"]) {
      const value = (detail as unknown as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
    detail = detail.cause;
  }
  return undefined;
}

async function rejectsWith(
  run: () => Promise<unknown>,
  constraint: string,
): Promise<void> {
  await assert.rejects(run, (error) => {
    assert.equal(constraintOf(error), constraint);
    return true;
  });
}

for (const backend of revisionBackends) {
  const options = { skip: backend === "postgres" && !revisionPostgresUrl };

  it(
    `stores embeddings with an appended snapshot on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const note = await snapshot(fixture, { type: "Note", content: "a" });
        const like = await snapshot(fixture, { type: "Note", content: "b" });
        const parent = await snapshot(fixture, { type: "Create" }, [
          {
            path: ["object", 0],
            sourceRevisionId: note.revision.id,
            relation: "snapshot",
          },
          {
            path: ["object", 1, "inReplyTo"],
            sourceRevisionId: like.revision.id,
            relation: "derived",
          },
        ]);
        assert.deepEqual(await embeddingRows(fixture, parent.revision.id), [
          {
            path: ["object", 0],
            sourceRevisionId: note.revision.id,
            relation: "snapshot",
          },
          {
            path: ["object", 1, "inReplyTo"],
            sourceRevisionId: like.revision.id,
            relation: "derived",
          },
        ]);
        // The relations reach the rows from either side.
        const loaded = await fixture.db.query.resourceRevisions.findFirst({
          where: { id: parent.revision.id },
          with: { embeddings: { with: { source: true } } },
        });
        assert.deepEqual(
          loaded?.embeddings
            .map(({ source }) => source.id)
            .toSorted((left, right) => left.localeCompare(right)),
          [note.revision.id, like.revision.id].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        );
        // A snapshot without embeddings stores none.
        assert.deepEqual(await embeddingRows(fixture, note.revision.id), []);
      });
    },
  );

  it(`stores embeddings with a typed edit on ${backend}`, options, async () => {
    await withRevisionDatabase(backend, async (fixture) => {
      const instanceId = uuidV7();
      const actorId = uuidV7();
      const objectId = uuidV7() as Uuid;
      const iri = `https://typed.example/objects/${objectId}`;
      const document = { id: iri, type: "Note", content: "first" };
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
        await storeAddressing(tx, objectId, { to: [PUBLIC] });
        return await captureLegacyResourceRevision(tx, objectId);
      });
      const attachment = await snapshot(fixture, {
        type: "Document",
        name: "attached",
      });
      const edited = await writeTypedResourceRevision(fixture.db, {
        resourceId: objectId,
        expectedRevisionId: revisionId,
        kind: "snapshot",
        document: {
          ...document,
          content: "second",
          attachment: { type: "Document", name: "attached" },
        },
        columns: {
          url: null,
          name: null,
          summary: null,
          contentHtml: "second",
          language: null,
          sensitive: false,
          published: Temporal.Instant.from("2026-11-01T00:00:00Z"),
          updated: Temporal.Instant.from("2026-11-02T00:00:00Z"),
        },
        addressingOccurrences: [{ property: "to", position: 0, iri: PUBLIC }],
        embeddings: [
          {
            path: ["attachment"],
            sourceRevisionId: attachment.revision.id,
            relation: "snapshot",
          },
        ],
      });
      assert.equal(edited.sequence, 2);
      assert.deepEqual(await embeddingRows(fixture, edited.id), [
        {
          path: ["attachment"],
          sourceRevisionId: attachment.revision.id,
          relation: "snapshot",
        },
      ]);
    });
  });

  it(
    `rejects embedding sources that are no other resource's snapshot on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const deleted = await snapshot(fixture, { type: "Note" });
        const whiteout = await appendResourceRevision(fixture.db, {
          resourceId: deleted.resource.id,
          resourceKind: "object",
          expectedRevisionId: deleted.revision.id,
          kind: "whiteout",
          deleted: Temporal.Now.instant(),
          formerTypes: ["Note"],
        });
        const embedding = (sourceRevisionId: Uuid): RevisionEmbeddingInput => ({
          path: ["object"],
          sourceRevisionId,
          relation: "snapshot",
        });
        await rejectsWith(
          () => snapshot(fixture, { type: "Create" }, [embedding(whiteout.id)]),
          "revision_embeddings_source_kind_guard",
        );
        await rejectsWith(
          () =>
            snapshot(fixture, { type: "Create" }, [
              embedding(uuidV7() as Uuid),
            ]),
          "revision_embeddings_source_revision_fkey",
        );
        const edited = await snapshot(fixture, { type: "Note" });
        await rejectsWith(
          () =>
            appendResourceRevision(fixture.db, {
              resourceId: edited.resource.id,
              resourceKind: "object",
              expectedRevisionId: edited.revision.id,
              kind: "snapshot",
              document: { type: "Note", content: "again" },
              capture: "local",
              embeddings: [embedding(edited.revision.id)],
            }),
          "revision_embeddings_source_resource_guard",
        );
        // A rejected embedding leaves no part of the revision behind.
        const head = await loadCurrentResourceRevision(
          fixture.db,
          edited.resource.id,
        );
        assert.equal(head?.id, edited.revision.id);
        const { rows } = await fixture.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM resource_revisions WHERE kind = 'snapshot' AND document::text = $1",
          [JSON.stringify({ type: "Create" })],
        );
        assert.equal(Number(rows[0]?.count), 0);
      });
    },
  );

  it(
    `seals embeddings with their published revision on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const note = await snapshot(fixture, { type: "Note" });
        const other = await snapshot(fixture, { type: "Note" });
        const parent = await snapshot(fixture, { type: "Create" }, [
          {
            path: ["object"],
            sourceRevisionId: note.revision.id,
            relation: "snapshot",
          },
        ]);
        await rejectsWith(
          () =>
            fixture.query(
              `INSERT INTO revision_embeddings (revision_id, path, source_revision_id, relation) VALUES ($1, '["target"]', $2, 'derived')`,
              [parent.revision.id, other.revision.id],
            ),
          "revision_embeddings_sealed",
        );
        await rejectsWith(
          () =>
            fixture.query(
              "UPDATE revision_embeddings SET relation = 'derived' WHERE revision_id = $1",
              [parent.revision.id],
            ),
          "revision_embeddings_immutable",
        );
        await rejectsWith(
          () =>
            fixture.query(
              "DELETE FROM revision_embeddings WHERE revision_id = $1",
              [parent.revision.id],
            ),
          "revision_embeddings_immutable",
        );
        await rejectsWith(
          () => fixture.query("TRUNCATE revision_embeddings"),
          "revision_embeddings_immutable",
        );
        assert.equal(
          (await embeddingRows(fixture, parent.revision.id)).length,
          1,
        );
      });
    },
  );

  it(
    `validates embedding input before writing on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const note = await snapshot(fixture, { type: "Note" });
        const sourceRevisionId = note.revision.id;
        const invalid: unknown[] = [
          "not a list",
          [{ path: [], sourceRevisionId, relation: "snapshot" }],
          [{ path: "object", sourceRevisionId, relation: "snapshot" }],
          [{ path: ["object", -1], sourceRevisionId, relation: "snapshot" }],
          [{ path: ["object", 1.5], sourceRevisionId, relation: "snapshot" }],
          [{ path: [true], sourceRevisionId, relation: "snapshot" }],
          [
            { path: ["object"], sourceRevisionId, relation: "snapshot" },
            { path: ["object"], sourceRevisionId, relation: "derived" },
          ],
          [
            {
              path: ["object"],
              sourceRevisionId: "not-a-uuid",
              relation: "snapshot",
            },
          ],
          [{ path: ["object"], sourceRevisionId, relation: "copy" }],
        ];
        for (const embeddings of invalid) {
          await assert.rejects(
            () =>
              snapshot(
                fixture,
                { type: "Create" },
                embeddings as readonly RevisionEmbeddingInput[],
              ),
            TypeError,
          );
        }
        const { rows } = await fixture.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM revision_embeddings",
        );
        assert.equal(Number(rows[0]?.count), 0);
      });
    },
  );
}
