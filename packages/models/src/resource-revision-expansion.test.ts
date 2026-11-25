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

import { expandDocument } from "@drfed/models/expansion";
import { ensureResource, storeAddressing } from "@drfed/models/resource";
import {
  type JsonObject,
  appendResourceRevision,
  captureLegacyResourceRevision,
  loadRevisionExpansion,
  recordRevisionExpansion,
  writeTypedResourceRevision,
} from "@drfed/models/resource-revision";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";

import {
  type RevisionFixture,
  revisionBackends,
  revisionPostgresUrl,
  withRevisionDatabase,
} from "./resource-revision-fixture.ts";

const AS = "https://www.w3.org/ns/activitystreams";
const AS_NS = "https://www.w3.org/ns/activitystreams#";
const PUBLIC = `${AS_NS}Public`;

async function append(fixture: RevisionFixture, document: JsonObject) {
  const resource = await ensureResource(
    fixture.db,
    `https://example.test/resources/${uuidV7()}`,
  );
  return await appendResourceRevision(fixture.db, {
    resourceId: resource.id,
    resourceKind: "object",
    expectedRevisionId: null,
    kind: "snapshot",
    document,
    capture: "local",
  });
}

async function expansionOf(fixture: RevisionFixture, revisionId: Uuid) {
  const row = await loadRevisionExpansion(fixture.db, revisionId);
  assert.ok(row !== null, "the revision has an expansion");
  const { revisionId: _revisionId, ...rest } = row;
  return rest;
}

async function legacyObject(
  fixture: RevisionFixture,
  document: JsonObject,
  {
    deleted = null,
    fetched = true,
  }: { readonly deleted?: string | null; readonly fetched?: boolean } = {},
) {
  const instanceId = uuidV7();
  const actorId = uuidV7();
  const objectId = uuidV7() as Uuid;
  const iri = `https://typed.example/objects/${objectId}`;
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
    "INSERT INTO objects (id, actor_id, type, content_html, document, deleted, fetched) VALUES ($1, $2, 'Note', 'first', $3::json, $4::timestamptz, $5)",
    [
      objectId,
      actorId,
      JSON.stringify({ ...document, id: iri }),
      deleted,
      fetched,
    ],
  );
  await fixture.db.transaction(
    async (tx) => await storeAddressing(tx, objectId, { to: [PUBLIC] }),
  );
  return { objectId, document: { ...document, id: iri } };
}

async function capture(
  fixture: RevisionFixture,
  objectId: Uuid,
  options?: Parameters<typeof captureLegacyResourceRevision>[2],
) {
  return await fixture.db.transaction(
    async (tx) => await captureLegacyResourceRevision(tx, objectId, options),
  );
}

async function revisionIds(fixture: RevisionFixture, resourceId: Uuid) {
  const { rows } = await fixture.query<{ id: Uuid; kind: string }>(
    "SELECT id, kind::text AS kind FROM resource_revisions WHERE resource_id = $1 ORDER BY sequence",
    [resourceId],
  );
  return rows;
}

for (const backend of revisionBackends) {
  const options = { skip: backend === "postgres" && !revisionPostgresUrl };

  it(
    `expands an appended snapshot offline on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const document = {
          "@context": AS,
          type: "Note",
          content: "foo",
          bogus: 1,
        };
        const revision = await append(fixture, document);
        const expected = await expandDocument(document);
        assert.equal(expected.outcome, "expanded");
        assert.deepEqual(await expansionOf(fixture, revision.id), {
          outcome: "expanded",
          document: expected.outcome === "expanded" ? expected.document : null,
          droppedTerms: [],
          undefinedTerms: ["bogus"],
          failure: null,
          sourceRevisionId: null,
        });
        // The expanded document can be queried by containment.
        const { rows } = await fixture.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM revision_expansions WHERE revision_id = $1 AND document @> $2::jsonb",
          [revision.id, JSON.stringify([{ "@type": [`${AS_NS}Note`] }])],
        );
        assert.equal(rows[0]?.count, 1);
      });
    },
  );

  it(`normalizes what jsonb refuses on ${backend}`, options, async () => {
    await withRevisionDatabase(backend, async (fixture) => {
      const document = {
        "@context": AS,
        type: "Note",
        content: "a\u0000b \ud800",
        "nul\u0000key": -0,
      };
      const revision = await append(fixture, document);
      const expansion = await expansionOf(fixture, revision.id);
      assert.equal(expansion.outcome, "expanded");
      assert.deepEqual(expansion.document, [
        {
          "@type": [`${AS_NS}Note`],
          [`${AS_NS}content`]: [{ "@value": "a\uFFFDb \uFFFD" }],
          "_:nul\uFFFDkey": [{ "@value": 0 }],
        },
      ]);
      assert.deepEqual(expansion.undefinedTerms, ["nul\uFFFDkey"]);
      // The stored document keeps the exact values.
      const { rows } = await fixture.query<{ document: string }>(
        "SELECT document::text AS document FROM resource_revisions WHERE id = $1",
        [revision.id],
      );
      assert.match(rows[0]!.document, /a\\u0000b \\ud800/u);
      assert.match(rows[0]!.document, /:-0\}/u);
    });
  });

  it(`records a failed expansion on ${backend}`, options, async () => {
    await withRevisionDatabase(backend, async (fixture) => {
      const revision = await append(fixture, {
        "@context": "https://example.test/context",
        type: "Note",
      });
      const expansion = await expansionOf(fixture, revision.id);
      assert.equal(expansion.outcome, "failed");
      assert.match(expansion.failure ?? "", /^jsonld\.\w+: /u);
      assert.equal(expansion.document, null);
    });
  });

  it(
    `stores a given expansion and its source on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const source = await append(fixture, {
          "@context": AS,
          type: "Create",
        });
        const resource = await ensureResource(
          fixture.db,
          `https://example.test/resources/${uuidV7()}`,
        );
        const revision = await appendResourceRevision(fixture.db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { type: "Note", content: "\u0000" },
          capture: "embedded",
          expansion: {
            outcome: "failed",
            failure: "context \u0000 \ud800",
            sourceRevisionId: source.id,
          },
        });
        assert.deepEqual(await expansionOf(fixture, revision.id), {
          outcome: "failed",
          document: null,
          droppedTerms: null,
          undefinedTerms: null,
          failure: "context \uFFFD \uFFFD",
          sourceRevisionId: source.id,
        });
      });
    },
  );

  it(`rejects a malformed expansion on ${backend}`, options, async () => {
    await withRevisionDatabase(backend, async (fixture) => {
      const resource = await ensureResource(
        fixture.db,
        `https://example.test/resources/${uuidV7()}`,
      );
      await assert.rejects(
        appendResourceRevision(fixture.db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { type: "Note" },
          capture: "local",
          expansion: { outcome: "no_document" } as never,
        }),
        TypeError,
      );
      assert.deepEqual(await revisionIds(fixture, resource.id), []);
      // An embedded snapshot cannot be expanded without what it inherits.
      await assert.rejects(
        appendResourceRevision(fixture.db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { type: "Note" },
          capture: "embedded",
        }),
        /needs its given expansion/u,
      );
      assert.deepEqual(await revisionIds(fixture, resource.id), []);
      // An embedded expansion names the revision it was taken from.
      await assert.rejects(
        appendResourceRevision(fixture.db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { type: "Note" },
          capture: "embedded",
          expansion: {
            outcome: "expanded",
            document: [],
            droppedTerms: [],
            undefinedTerms: [],
          },
        }),
        /names the revision it was taken from/u,
      );
      assert.deepEqual(await revisionIds(fixture, resource.id), []);
      // The table refuses rows whose columns contradict their outcome.
      const revision = await append(fixture, { type: "Note" });
      await assert.rejects(
        fixture.query(
          "UPDATE revision_expansions SET document = NULL WHERE revision_id = $1",
          [revision.id],
        ),
      );
    });
  });

  it(
    `records whiteouts without a document on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const first = await append(fixture, { "@context": AS, type: "Note" });
        const whiteout = await appendResourceRevision(fixture.db, {
          resourceId: first.resourceId,
          resourceKind: "object",
          expectedRevisionId: first.id,
          kind: "whiteout",
          deleted: Temporal.Now.instant(),
          formerTypes: [`${AS_NS}Note`],
        });
        assert.deepEqual(await expansionOf(fixture, whiteout.id), {
          outcome: "no_document",
          document: null,
          droppedTerms: null,
          undefinedTerms: null,
          failure: null,
          sourceRevisionId: null,
        });
      });
    },
  );

  it(`expands legacy captures on ${backend}`, options, async () => {
    await withRevisionDatabase(backend, async (fixture) => {
      const live = await legacyObject(fixture, {
        "@context": AS,
        type: "Note",
        content: "first",
      });
      const given = await expandDocument(live.document);
      assert.equal(given.outcome, "expanded");
      if (given.outcome !== "expanded") return;
      const revisionId = await capture(fixture, live.objectId, {
        expansion: { ...given, undefinedTerms: ["marker"] },
      });
      assert.deepEqual(
        (await expansionOf(fixture, revisionId)).undefinedTerms,
        ["marker"],
      );
      // A repeated capture keeps the recorded expansion.
      assert.equal(await capture(fixture, live.objectId), revisionId);
      assert.deepEqual(
        (await expansionOf(fixture, revisionId)).undefinedTerms,
        ["marker"],
      );
      // A reused fetched revision without one, as from before expansions,
      // gets no offline failure that would keep the backfill away, but takes
      // a given expansion.
      await fixture.query(
        "DELETE FROM revision_expansions WHERE revision_id = $1",
        [revisionId],
      );
      assert.equal(await capture(fixture, live.objectId), revisionId);
      assert.equal(await loadRevisionExpansion(fixture.db, revisionId), null);
      assert.equal(
        await capture(fixture, live.objectId, { expansion: given }),
        revisionId,
      );
      assert.deepEqual(await expansionOf(fixture, revisionId), {
        ...given,
        failure: null,
        sourceRevisionId: null,
      });

      const deleted = await legacyObject(
        fixture,
        { "@context": AS, type: "Note", content: "gone" },
        { deleted: "2026-11-01T00:00:00Z" },
      );
      await capture(fixture, deleted.objectId);
      const [snapshot, whiteout] = await revisionIds(fixture, deleted.objectId);
      assert.equal(snapshot?.kind, "snapshot");
      assert.equal(whiteout?.kind, "whiteout");
      assert.equal(await loadRevisionExpansion(fixture.db, snapshot.id), null);
      assert.equal(
        (await expansionOf(fixture, whiteout.id)).outcome,
        "no_document",
      );

      // Recording checks the expansion against the revision's kind.
      await assert.rejects(
        recordRevisionExpansion(fixture.db, snapshot.id, null),
        /A snapshot has a document to expand\./u,
      );
      await assert.rejects(
        recordRevisionExpansion(fixture.db, whiteout.id, given),
        /no document to expand/u,
      );
      assert.equal(
        await recordRevisionExpansion(fixture.db, snapshot.id, given),
        "expanded",
      );
      assert.equal(
        await recordRevisionExpansion(fixture.db, snapshot.id, given),
        null,
      );

      // An embedded object lacks the context it inherits, so without a given
      // expansion it is left for the backfill.
      const embedded = await legacyObject(
        fixture,
        { type: "Note", content: "inherited" },
        { fetched: false },
      );
      const embeddedId = await capture(fixture, embedded.objectId);
      assert.equal(await loadRevisionExpansion(fixture.db, embeddedId), null);
    });
  });

  it(`expands typed edits on ${backend}`, options, async () => {
    await withRevisionDatabase(backend, async (fixture) => {
      const { objectId, document } = await legacyObject(fixture, {
        "@context": AS,
        type: "Note",
        content: "first",
      });
      const revisionId = await capture(fixture, objectId);
      const edited = await writeTypedResourceRevision(fixture.db, {
        resourceId: objectId,
        expectedRevisionId: revisionId,
        kind: "snapshot",
        document: { ...document, content: "second" },
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
      });
      const expansion = await expansionOf(fixture, edited.id);
      assert.equal(expansion.outcome, "expanded");
      assert.deepEqual(
        (expansion.document as Record<string, unknown>[])[0]?.[
          `${AS_NS}content`
        ],
        [{ "@value": "second" }],
      );
    });
  });

  it(
    `fixes a given expansion when appending on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const resource = await ensureResource(
          fixture.db,
          `https://example.test/resources/${uuidV7()}`,
        );
        const undefinedTerms = ["first"];
        const appending = appendResourceRevision(fixture.db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { type: "Note" },
          capture: "local",
          expansion: {
            outcome: "expanded",
            document: [],
            droppedTerms: [],
            undefinedTerms,
          },
        });
        // A change after the call does not reach the stored expansion.
        undefinedTerms.push("later");
        const revision = await appending;
        assert.deepEqual(
          (await expansionOf(fixture, revision.id)).undefinedTerms,
          ["first"],
        );

        // An expansion JSON cannot hold is recorded as a failure.
        const other = await ensureResource(
          fixture.db,
          `https://example.test/resources/${uuidV7()}`,
        );
        const infinite = await appendResourceRevision(fixture.db, {
          resourceId: other.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { type: "Note" },
          capture: "local",
          expansion: {
            outcome: "expanded",
            document: [{ "urn:width": [{ "@value": Infinity }] }],
            droppedTerms: [],
            undefinedTerms: [],
          },
        });
        const failed = await expansionOf(fixture, infinite.id);
        assert.equal(failed.outcome, "failed");
        assert.match(
          failed.failure ?? "",
          /cannot be stored as JSON: .*finite/u,
        );
      });
    },
  );
}
