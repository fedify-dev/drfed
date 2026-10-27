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

// Keep dependent document writes and their observations sequential.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";
import { it } from "node:test";

import {
  ResourceKindConflictError,
  ensureResource,
} from "@drfed/models/resource";
import {
  LegacyResourceRevisionError,
  RevisionConflictError,
  appendResourceRevision,
  listResourceRevisions,
  loadCurrentResourceRevision,
  loadResourceRevision,
} from "@drfed/models/resource-revision";
import { uuidV7 } from "@drfed/models/uuid";

import {
  type RevisionFixture,
  revisionBackends,
  revisionConnection,
  revisionPostgresUrl,
  withRevisionDatabase,
} from "./resource-revision-fixture.ts";

type RevisionInput = Parameters<typeof appendResourceRevision>[1];
type SnapshotInput = Extract<RevisionInput, { kind: "snapshot" }>;
type Document = SnapshotInput["document"];

const activityTypes = [
  "Activity",
  "IntransitiveActivity",
  "Accept",
  "Add",
  "Announce",
  "Arrive",
  "Block",
  "Create",
  "Delete",
  "Dislike",
  "Flag",
  "Follow",
  "Ignore",
  "Invite",
  "Join",
  "Leave",
  "Like",
  "Listen",
  "Move",
  "Offer",
  "Question",
  "Read",
  "Reject",
  "Remove",
  "TentativeAccept",
  "TentativeReject",
  "Travel",
  "Undo",
  "Update",
  "View",
] as const;

async function initial(
  fixture: RevisionFixture,
  document: Document,
  values: Partial<
    Omit<
      SnapshotInput,
      "resourceId" | "document" | "kind" | "expectedRevisionId"
    >
  > = {},
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
    ...values,
  });
  return { resource, revision };
}

async function legacyObject(fixture: RevisionFixture) {
  const instanceId = uuidV7();
  const actorId = uuidV7();
  const objectId = uuidV7();
  await fixture.query(
    "INSERT INTO instances (id, host) VALUES ($1, 'legacy.example')",
    [instanceId],
  );
  await fixture.query(
    "INSERT INTO resources (id, iri, kind) VALUES ($1, 'https://legacy.example/actor', 'actor'), ($2, 'https://legacy.example/object', 'object')",
    [actorId, objectId],
  );
  await fixture.query(
    "INSERT INTO actors (id, type, instance_id, inbox_url) VALUES ($1, 'Person', $2, 'https://legacy.example/inbox')",
    [actorId, instanceId],
  );
  await fixture.query(
    "INSERT INTO objects (id, actor_id, type, content_html, document) VALUES ($1, $2, 'Note', 'legacy', $3::json)",
    [objectId, actorId, JSON.stringify({ type: "Note", content: "legacy" })],
  );
  return objectId;
}

for (const backend of revisionBackends) {
  const options = { skip: backend === "postgres" && !revisionPostgresUrl };

  it(
    `round-trips every activity type without Note-only fields on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        for (const type of activityTypes) {
          const document = {
            "@context": [
              "https://www.w3.org/ns/activitystreams",
              { test: "https://example.test/vocab#" },
            ],
            type,
            "test:extension": {
              ordered: [2, 1, 2],
              enabled: false,
              negativeZero: -0,
              empty: null,
            },
          };
          // oxlint-disable-next-line no-await-in-loop
          const { resource, revision } = await initial(fixture, document, {
            resourceKind: "activity",
            capture: "received",
          });
          assert.equal(revision.sequence, 1);
          assert.equal(revision.kind, "snapshot");
          assert.equal(revision.capture, "received");
          // oxlint-disable-next-line no-await-in-loop
          assert.deepEqual(
            (await loadResourceRevision(fixture.db, revision.id))?.document,
            document,
          );
          // oxlint-disable-next-line no-await-in-loop
          assert.equal(
            (await ensureResource(fixture.db, resource.iri)).kind,
            "activity",
          );
          // oxlint-disable-next-line no-await-in-loop
          assert.equal(
            (
              await fixture.query("SELECT * FROM activities WHERE id=$1", [
                resource.id,
              ])
            ).rows.length,
            0,
          );
        }
      });
    },
  );

  it(
    `preserves nested values, extension contexts, IRIs, and explicit projections on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const documents: Document[] = [
          {
            type: "Undo",
            object: {
              type: "Like",
              object: "https://remote.test/note",
              "test:flag": false,
            },
          },
          {
            type: "Accept",
            object: { type: "Follow", object: "https://remote.test/actor" },
          },
          {
            type: "Add",
            object: ["urn:one", { type: "Object", "test:unknown": [null, 3] }],
            target: {
              type: "OrderedCollection",
              id: "urn:collection",
              orderedItems: [],
            },
          },
          { type: "Arrive", location: { type: "Place", name: "Somewhere" } },
          {
            type: "Create",
            object: {
              type: "Question",
              oneOf: [
                { type: "Note", name: "A" },
                { type: "Note", name: "B" },
              ],
              closed: false,
            },
          },
          {
            type: "Question",
            anyOf: [{ name: "A" }, { name: "B" }],
            endTime: "2026-11-01T00:00:00Z",
          },
          {
            type: ["Note", "https://example.test/vocab#Custom"],
            content: "\0",
            "test:unknown": { value: "\ud800" },
          },
          // An alias named `to` must not be treated as addressing by the storage layer.
          {
            "@context": { to: "https://example.test/vocab#unrelated" },
            type: "https://example.test/vocab#Unknown",
            to: "Public",
          },
        ];
        for (const document of documents) {
          // oxlint-disable-next-line no-await-in-loop
          const { revision } = await initial(fixture, document);
          // oxlint-disable-next-line no-await-in-loop
          const reloaded = await loadResourceRevision(fixture.db, revision.id);
          assert.deepEqual(reloaded?.document, document);
          assert.deepEqual(reloaded?.addressing, []);
          assert.deepEqual(reloaded?.relations, []);
        }
        const nonCanonicalIri = "https://REMOTE.test:443/object";
        const document: Document = {
          id: nonCanonicalIri,
          type: "Add",
          object: [
            "urn:unresolved",
            { type: "Note", content: "embedded" },
            { type: "Link", href: "urn:linked" },
          ],
          target: "urn:collection",
          to: ["urn:recipient", "urn:recipient"],
          bcc: ["urn:blind"],
        };
        const relations = [
          {
            property: "https://www.w3.org/ns/activitystreams#object",
            path: ["object", 0],
            representation: "reference",
            targetIri: "urn:unresolved",
          },
          {
            property: "https://www.w3.org/ns/activitystreams#object",
            path: ["object", 1],
            representation: "embedded",
            targetIri: null,
          },
          {
            property: "https://www.w3.org/ns/activitystreams#object",
            path: ["object", 2],
            representation: "link",
            targetIri: "urn:linked",
          },
          {
            property: "https://www.w3.org/ns/activitystreams#target",
            path: ["target"],
            representation: "reference",
            targetIri: "urn:collection",
          },
        ] as const;
        const { revision } = await initial(fixture, document, {
          addressing: {
            to: ["urn:recipient", "urn:recipient"],
            cc: ["urn:collection"],
            bcc: ["urn:blind"],
          },
          relations,
          projection: "complete",
        });
        const reloaded = await loadResourceRevision(fixture.db, revision.id);
        assert.deepEqual(reloaded?.document, document);
        assert.equal(reloaded?.projection, "complete");
        assert.deepEqual(
          reloaded?.addressing.map(({ property, position, iri }) => ({
            property,
            position,
            iri,
          })),
          [
            { property: "to", position: 0, iri: "urn:recipient" },
            { property: "to", position: 1, iri: "urn:recipient" },
            { property: "cc", position: 0, iri: "urn:collection" },
            { property: "bcc", position: 0, iri: "urn:blind" },
          ],
        );
        assert.deepEqual(
          reloaded?.relations.map(
            ({ property, path, representation, targetIri }) => ({
              property,
              path,
              representation,
              targetIri,
            }),
          ),
          relations,
        );
        assert.equal(
          (
            await fixture.query(
              "SELECT * FROM resources WHERE iri LIKE 'urn:%'",
            )
          ).rows.length,
          0,
        );
        // Mutating input after saving must not mutate the stored revision.
        (document as { target: string }).target = "urn:changed";
        const afterMutation = await loadResourceRevision(
          fixture.db,
          revision.id,
        );
        assert.ok(afterMutation?.document);
        assert.equal(
          (afterMutation.document as Document).target,
          "urn:collection",
        );
      });
    },
  );

  it(
    `retains A and B after a whiteout and keeps Activity embeddings fixed on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const a: Document = { type: "Note", content: "A", bcc: ["urn:blind"] };
        const { resource, revision: first } = await initial(fixture, a, {
          addressing: {
            to: ["urn:recipient", "urn:recipient"],
            bcc: ["urn:blind"],
          },
          relations: [
            {
              property: "https://www.w3.org/ns/activitystreams#inReplyTo",
              path: ["inReplyTo"],
              representation: "reference",
              targetIri: "urn:thread",
            },
          ],
          projection: "complete",
        });
        const embedded = await initial(
          fixture,
          { type: "Create", object: a },
          { resourceKind: "activity" },
        );
        const reference = await initial(
          fixture,
          { type: "Create", object: resource.iri },
          { resourceKind: "activity" },
        );
        const second = await appendResourceRevision(fixture.db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: first.id,
          kind: "snapshot",
          document: { type: "Note", content: "B" },
          capture: "local",
          addressing: { to: ["urn:next"], bcc: ["urn:next-blind"] },
          relations: [
            {
              property: "https://www.w3.org/ns/activitystreams#inReplyTo",
              path: ["inReplyTo"],
              representation: "reference",
              targetIri: "urn:next-thread",
            },
          ],
          projection: "complete",
        });
        const deleted = Temporal.Instant.from("2026-10-27T00:00:00Z");
        const whiteout = await appendResourceRevision(fixture.db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: second.id,
          kind: "whiteout",
          deleted,
          formerTypes: ["Note"],
        });
        assert.equal(whiteout.sequence, 3);
        assert.equal(whiteout.kind, "whiteout");
        assert.equal(whiteout.document, null);
        assert.equal(whiteout.deleted?.equals(deleted), true);
        assert.deepEqual(whiteout.formerTypes, ["Note"]);
        assert.equal(whiteout.capture, second.capture);
        assert.equal(whiteout.projection, second.projection);
        assert.deepEqual(
          whiteout.addressing.map(({ property, position, iri }) => ({
            property,
            position,
            iri,
          })),
          second.addressing.map(({ property, position, iri }) => ({
            property,
            position,
            iri,
          })),
        );
        assert.deepEqual(
          whiteout.relations.map(
            ({ property, path, representation, targetIri }) => ({
              property,
              path,
              representation,
              targetIri,
            }),
          ),
          second.relations.map(
            ({ property, path, representation, targetIri }) => ({
              property,
              path,
              representation,
              targetIri,
            }),
          ),
        );
        assert.equal(
          (await loadCurrentResourceRevision(fixture.db, resource.id))?.id,
          whiteout.id,
        );
        assert.deepEqual(
          (await loadResourceRevision(fixture.db, first.id))?.document,
          a,
        );
        assert.deepEqual(
          (await loadResourceRevision(fixture.db, second.id))?.document,
          { type: "Note", content: "B" },
        );
        assert.deepEqual(
          (await loadResourceRevision(fixture.db, embedded.revision.id))
            ?.document,
          { type: "Create", object: a },
        );
        assert.deepEqual(
          (await loadResourceRevision(fixture.db, reference.revision.id))
            ?.document,
          { type: "Create", object: resource.iri },
        );
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: resource.id,
            resourceKind: "object",
            expectedRevisionId: whiteout.id,
            kind: "snapshot",
            document: { type: "Note", content: "revived" },
            capture: "local",
          }),
        );
        const legacyId = await legacyObject(fixture);
        const historicalDocument: Document = {
          type: "Create",
          object: {
            id: "https://legacy.example/object",
            type: "Note",
            content: "legacy",
          },
        };
        const historical = await initial(fixture, historicalDocument, {
          resourceKind: "activity",
        });
        await fixture.query("DELETE FROM objects WHERE id=$1", [legacyId]);
        await fixture.query("DELETE FROM resources WHERE id=$1", [legacyId]);
        assert.deepEqual(
          (await loadResourceRevision(fixture.db, historical.revision.id))
            ?.document,
          historicalDocument,
        );
        const history = await listResourceRevisions(fixture.db, resource.id, {
          limit: 2,
        });
        assert.deepEqual(
          history.map(({ id }) => id),
          [whiteout.id, second.id],
        );
        assert.deepEqual(
          (
            await listResourceRevisions(fixture.db, resource.id, {
              beforeSequence: second.sequence,
              limit: 2,
            })
          ).map(({ id }) => id),
          [first.id],
        );
        assert.deepEqual(
          (
            await listResourceRevisions(fixture.db, resource.id, {
              beforeSequence: first.sequence,
            })
          ).map(({ id }) => id),
          [],
        );
        for (const limit of [0, -1, 101, 1.5, NaN]) {
          // oxlint-disable-next-line no-await-in-loop
          await assert.rejects(
            listResourceRevisions(fixture.db, resource.id, { limit }),
          );
        }
      });
    },
  );

  it(
    `rejects stale writers, immutable Activities, and all legacy rows on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        assert.equal(
          await loadCurrentResourceRevision(fixture.db, uuidV7()),
          null,
        );
        assert.equal(await loadResourceRevision(fixture.db, uuidV7()), null);
        const { resource, revision } = await initial(fixture, { type: "Note" });
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: resource.id,
            resourceKind: "activity",
            expectedRevisionId: null,
            kind: "snapshot",
            document: { type: "Arrive" },
            capture: "local",
          }),
          (error: unknown) =>
            error instanceof RevisionConflictError &&
            error.resourceId === resource.id &&
            error.expectedRevisionId === null &&
            error.actualRevisionId === revision.id,
        );
        const activity = await initial(
          fixture,
          { type: "Arrive" },
          { resourceKind: "activity" },
        );
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: activity.resource.id,
            resourceKind: "activity",
            expectedRevisionId: activity.revision.id,
            kind: "snapshot",
            document: { type: "Arrive", name: "changed" },
            capture: "local",
          }),
        );
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: activity.resource.id,
            resourceKind: "activity",
            expectedRevisionId: activity.revision.id,
            kind: "whiteout",
            deleted: Temporal.Now.instant(),
            formerTypes: ["Arrive"],
          }),
        );
        const unknown = await ensureResource(
          fixture.db,
          `urn:kind-conflict:${uuidV7()}`,
        );
        await fixture.query(
          "UPDATE resources SET kind='collection' WHERE id=$1",
          [unknown.id],
        );
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: unknown.id,
            resourceKind: "object",
            expectedRevisionId: null,
            kind: "snapshot",
            document: { type: "Object" },
            capture: "local",
          }),
          ResourceKindConflictError,
        );
        const objectId = await legacyObject(fixture);
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: objectId,
            resourceKind: "object",
            expectedRevisionId: null,
            kind: "snapshot",
            document: { type: "Note", content: "substituted" },
            capture: "local",
          }),
          (error: unknown) =>
            error instanceof LegacyResourceRevisionError &&
            error.resourceId === objectId,
        );
        assert.equal(
          await loadCurrentResourceRevision(fixture.db, objectId),
          null,
        );
        assert.equal(
          (
            await fixture.query(
              "SELECT content_html FROM objects WHERE id=$1",
              [objectId],
            )
          ).rows[0]?.content_html,
          "legacy",
        );
        const legacyActivityId = uuidV7();
        await fixture.query(
          "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, 'activity')",
          [
            legacyActivityId,
            `https://legacy.example/activities/${legacyActivityId}`,
          ],
        );
        await fixture.query(
          "INSERT INTO activities (id, actor_id, type, published) SELECT $1, actor_id, 'Create', now() FROM objects WHERE id=$2",
          [legacyActivityId, objectId],
        );
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: legacyActivityId,
            resourceKind: "activity",
            expectedRevisionId: null,
            kind: "snapshot",
            document: { type: "Create", object: "urn:substituted" },
            capture: "local",
          }),
          (error: unknown) =>
            error instanceof LegacyResourceRevisionError &&
            error.resourceId === legacyActivityId,
        );
        assert.equal(
          await loadCurrentResourceRevision(fixture.db, legacyActivityId),
          null,
        );
        const empty = await ensureResource(
          fixture.db,
          `urn:no-initial-whiteout:${uuidV7()}`,
        );
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: empty.id,
            resourceKind: "object",
            expectedRevisionId: null,
            kind: "whiteout",
            deleted: Temporal.Now.instant(),
            formerTypes: [],
          }),
        );
        assert.equal(
          (await ensureResource(fixture.db, empty.iri)).kind,
          "unknown",
        );
      });
    },
  );

  it(
    `continues a caller transaction after an append savepoint fails on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        await fixture.query(`CREATE FUNCTION fail_savepoint_relation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.property = 'urn:fail-savepoint' THEN RAISE EXCEPTION 'injected savepoint failure'; END IF; RETURN NEW; END $$`);
        await fixture.query(
          "CREATE TRIGGER fail_savepoint_relation BEFORE INSERT ON revision_relations FOR EACH ROW EXECUTE FUNCTION fail_savepoint_relation()",
        );
        const iri = `urn:savepoint:${uuidV7()}`;
        const beforeIri = `urn:before-savepoint:${uuidV7()}`;
        const afterIri = `urn:after-savepoint:${uuidV7()}`;
        const committed = await fixture.db.transaction(async (tx) => {
          const before = await ensureResource(tx, beforeIri);
          const resource = await ensureResource(tx, iri);
          const document = { type: "Note", content: "committed" };
          // A SQL error after inserting content and addressing must roll back
          // only the append, including its initial canonical-kind promotion.
          await assert.rejects(
            appendResourceRevision(tx, {
              resourceId: resource.id,
              resourceKind: "object",
              expectedRevisionId: null,
              kind: "snapshot",
              capture: "local",
              document: { type: "Note", content: "must disappear" },
              addressing: { to: ["urn:failed-recipient"] },
              relations: [
                {
                  property: "urn:fail-savepoint",
                  representation: "reference",
                  targetIri: "urn:failed-target",
                },
              ],
            }),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              assert.match(
                String(error.cause ?? error),
                /injected savepoint failure/u,
              );
              return true;
            },
          );
          assert.equal((await ensureResource(tx, iri)).kind, "unknown");
          assert.equal(
            await loadCurrentResourceRevision(tx, resource.id),
            null,
          );
          assert.deepEqual(await listResourceRevisions(tx, resource.id), []);
          // Work before the error survives, and new writes can still commit.
          assert.equal((await ensureResource(tx, beforeIri)).id, before.id);
          const after = await ensureResource(tx, afterIri);
          const revision = await appendResourceRevision(tx, {
            resourceId: resource.id,
            resourceKind: "object",
            expectedRevisionId: null,
            kind: "snapshot",
            capture: "local",
            document,
            addressing: { to: ["urn:committed-recipient"] },
            relations: [
              {
                property: "object",
                representation: "reference",
                targetIri: "urn:committed-target",
              },
            ],
          });
          assert.equal(revision.sequence, 1);
          return { resource, revision, before, after, document };
        });
        assert.equal(
          (await loadCurrentResourceRevision(fixture.db, committed.resource.id))
            ?.id,
          committed.revision.id,
        );
        assert.deepEqual(
          (await loadResourceRevision(fixture.db, committed.revision.id))
            ?.document,
          committed.document,
        );
        assert.deepEqual(
          (await listResourceRevisions(fixture.db, committed.resource.id)).map(
            ({ id }) => id,
          ),
          [committed.revision.id],
        );
        assert.equal(
          (await ensureResource(fixture.db, beforeIri)).id,
          committed.before.id,
        );
        assert.equal(
          (await ensureResource(fixture.db, afterIri)).id,
          committed.after.id,
        );
        assert.deepEqual(
          (await fixture.query("SELECT iri FROM revision_addressing")).rows,
          [{ iri: "urn:committed-recipient" }],
        );
        assert.deepEqual(
          (await fixture.query("SELECT target_iri FROM revision_relations"))
            .rows,
          [{ target_iri: "urn:committed-target" }],
        );
        assert.equal(
          (await fixture.query("SELECT * FROM resource_heads")).rows.length,
          1,
        );
      });
    },
  );

  it(
    `rolls back invalid JSON, projections, and mid-write failures on ${backend}`,
    options,
    async () => {
      await withRevisionDatabase(backend, async (fixture) => {
        const resource = await ensureResource(
          fixture.db,
          `urn:rollback:${uuidV7()}`,
        );
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        for (const document of [
          { type: "Object", bad: undefined },
          { type: "Object", bad: Infinity },
          { type: "Object", bad: () => undefined },
          { type: "Object", bad: BigInt(1) },
          { type: "Object", bad: new Date() },
          circular,
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          await assert.rejects(
            appendResourceRevision(fixture.db, {
              resourceId: resource.id,
              resourceKind: "object",
              expectedRevisionId: null,
              kind: "snapshot",
              document: document as never,
              capture: "local",
            }),
          );
        }
        for (const relations of [
          [
            {
              property: "object",
              path: ["object", -1],
              representation: "reference",
              targetIri: "urn:target",
            },
          ],
          [
            {
              property: "object",
              path: ["object", 0.5],
              representation: "reference",
              targetIri: "urn:target",
            },
          ],
          [
            {
              property: "object",
              path: ["object"],
              representation: "reference",
              targetIri: null,
            },
          ],
          [
            {
              property: "object\0",
              path: ["object"],
              representation: "reference",
              targetIri: "urn:target",
            },
          ],
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          await assert.rejects(
            appendResourceRevision(fixture.db, {
              resourceId: resource.id,
              resourceKind: "object",
              expectedRevisionId: null,
              kind: "snapshot",
              document: { type: "Object" },
              capture: "local",
              relations: relations as never,
            }),
          );
        }
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: resource.id,
            resourceKind: "object",
            expectedRevisionId: null,
            kind: "snapshot",
            document: { type: "Object" },
            capture: "local",
            addressing: { to: ["urn:invalid\0"] },
          }),
        );
        assert.equal(
          (await ensureResource(fixture.db, resource.iri)).kind,
          "unknown",
        );
        assert.equal(
          await loadCurrentResourceRevision(fixture.db, resource.id),
          null,
        );
        await fixture.query(`CREATE FUNCTION fail_test_revision_relation() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.property = 'urn:fail-write' THEN RAISE EXCEPTION 'injected projection failure'; END IF; RETURN NEW; END $$`);
        await fixture.query(
          "CREATE TRIGGER fail_test_revision_relation BEFORE INSERT ON revision_relations FOR EACH ROW EXECUTE FUNCTION fail_test_revision_relation()",
        );
        await assert.rejects(
          appendResourceRevision(fixture.db, {
            resourceId: resource.id,
            resourceKind: "object",
            expectedRevisionId: null,
            kind: "snapshot",
            document: { type: "Object", object: "urn:target" },
            capture: "local",
            addressing: { to: ["urn:recipient"] },
            relations: [
              {
                property: "urn:fail-write",
                path: ["object"],
                representation: "reference",
                targetIri: "urn:target",
              },
            ],
          }),
        );
        assert.equal(
          (await ensureResource(fixture.db, resource.iri)).kind,
          "unknown",
        );
        assert.equal(
          await loadCurrentResourceRevision(fixture.db, resource.id),
          null,
        );
        for (const table of [
          "resource_revisions",
          "resource_heads",
          "revision_addressing",
          "revision_relations",
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          assert.equal(
            (await fixture.query(`SELECT * FROM ${table}`)).rows.length,
            0,
          );
        }
        const committed = await appendResourceRevision(fixture.db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { type: "Object" },
          capture: "local",
        });
        assert.equal(committed.sequence, 1);
        const abortedIri = `urn:outer-aborted:${uuidV7()}`;
        await assert.rejects(
          fixture.db.transaction(async (tx) => {
            const outerResource = await ensureResource(tx, abortedIri);
            await appendResourceRevision(tx, {
              resourceId: outerResource.id,
              resourceKind: "object",
              expectedRevisionId: null,
              kind: "snapshot",
              document: { type: "Note", content: "must disappear" },
              capture: "local",
            });
            throw new Error("outer operation aborted");
          }),
          /outer operation aborted/u,
        );
        assert.equal(
          (
            await fixture.query("SELECT * FROM resources WHERE iri=$1", [
              abortedIri,
            ])
          ).rows.length,
          0,
        );
        assert.equal(
          (await fixture.query("SELECT * FROM resource_revisions")).rows.length,
          1,
        );
      });
    },
  );
}

it(
  "serializes concurrent first writers and stale CAS updates on PostgreSQL",
  { skip: !revisionPostgresUrl },
  async () => {
    await withRevisionDatabase("postgres", async (fixture) => {
      assert.ok(fixture.url);
      const one = revisionConnection(fixture.url);
      const two = revisionConnection(fixture.url);
      try {
        const resource = await ensureResource(
          fixture.db,
          `urn:concurrent:${uuidV7()}`,
        );
        const initialResults = await Promise.allSettled(
          [one, two].map((connection, index) =>
            appendResourceRevision(connection.db, {
              resourceId: resource.id,
              resourceKind: "object",
              expectedRevisionId: null,
              kind: "snapshot",
              document: { type: "Note", content: `first-${index}` },
              capture: "local",
            }),
          ),
        );
        const winners = initialResults.filter(
          (result) => result.status === "fulfilled",
        );
        const losers = initialResults.filter(
          (result) => result.status === "rejected",
        );
        assert.equal(winners.length, 1);
        assert.equal(losers.length, 1);
        const first = winners[0];
        const initialLoser = losers[0];
        assert.ok(first?.status === "fulfilled");
        assert.ok(initialLoser?.status === "rejected");
        assert.ok(initialLoser.reason instanceof RevisionConflictError);
        assert.equal(initialLoser.reason.actualRevisionId, first.value.id);
        assert.equal(
          (await listResourceRevisions(fixture.db, resource.id)).length,
          1,
        );
        const updates = await Promise.allSettled(
          [one, two].map((connection, index) =>
            appendResourceRevision(connection.db, {
              resourceId: resource.id,
              resourceKind: "object",
              expectedRevisionId: first.value.id,
              kind: "snapshot",
              document: { type: "Note", content: `second-${index}` },
              capture: "local",
            }),
          ),
        );
        const updated = updates.find((result) => result.status === "fulfilled");
        const stale = updates.find((result) => result.status === "rejected");
        assert.ok(updated?.status === "fulfilled");
        assert.ok(stale?.status === "rejected");
        assert.ok(stale.reason instanceof RevisionConflictError);
        assert.equal(stale.reason.expectedRevisionId, first.value.id);
        assert.equal(stale.reason.actualRevisionId, updated.value.id);
        assert.equal(
          (await loadCurrentResourceRevision(fixture.db, resource.id))?.id,
          updated.value.id,
        );
        assert.deepEqual(
          (await listResourceRevisions(fixture.db, resource.id)).map(
            ({ sequence }) => sequence,
          ),
          [2, 1],
        );
      } finally {
        await one.close();
        await two.close();
      }
    });
  },
);
