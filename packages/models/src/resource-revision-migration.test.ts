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

// Keep baseline insertion and migration comparisons sequential.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";
import { it } from "node:test";

import {
  LegacyResourceRevisionError,
  captureLegacyResourceRevision,
  loadCurrentResourceRevision,
  loadResourceRevision,
} from "@drfed/models/resource-revision";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";

import {
  type RevisionFixture,
  revisionBackends,
  revisionPostgresUrl,
  withRevisionDatabase,
} from "./resource-revision-fixture.ts";

const beforeMigration = "20261026181201_resource_revision_storage";
const created = "2026-10-01T01:02:03.123456Z";
const deleted = "2026-10-20T12:34:56.654321Z";

interface LegacyPair {
  readonly name: string;
  readonly objectId: Uuid;
  readonly activityId: Uuid;
  readonly objectDocument: string | null;
  readonly activityDocument: string | null;
  readonly objectCapture: "local" | "embedded" | "fetched";
  readonly activityCapture: "local" | "received";
  readonly deleted: boolean;
}

interface LegacyFixture {
  readonly pairs: readonly LegacyPair[];
  readonly embeddedDeliveryId: Uuid;
  readonly fetchedDeliveryId: Uuid;
  readonly unavailableObjectDeliveryId: Uuid;
}

async function seedLegacy(fixture: RevisionFixture): Promise<LegacyFixture> {
  const localInstance = uuidV7();
  const localInstanceId = uuidV7();
  const remoteInstance = uuidV7();
  const localActor = uuidV7();
  const localActorId = uuidV7();
  const remoteActor = uuidV7();
  await fixture.query(
    "INSERT INTO local_instances (id, slug, expires) VALUES ($1, 'revision-test', now() + interval '1 day')",
    [localInstanceId],
  );
  await fixture.query(
    "INSERT INTO instances (id, local_id, host) VALUES ($1, $2, 'revision-test.example'), ($3, NULL, 'remote.example')",
    [localInstance, localInstanceId, remoteInstance],
  );
  await fixture.query("INSERT INTO local_actors (id) VALUES ($1)", [
    localActorId,
  ]);
  await fixture.query(
    "INSERT INTO resources (id, iri, kind) VALUES ($1, 'https://revision-test.example/users/local', 'actor'), ($2, 'https://remote.example/users/remote', 'actor')",
    [localActor, remoteActor],
  );
  await fixture.query(
    "INSERT INTO actors (id, local_id, instance_id, type, username, inbox_url) VALUES ($1, $2, $3, 'Person', 'local', 'https://revision-test.example/inbox'), ($4, NULL, $5, 'Person', 'remote', 'https://remote.example/inbox')",
    [localActor, localActorId, localInstance, remoteActor, remoteInstance],
  );

  const definitions = [
    {
      name: "local",
      local: true,
      object:
        '{"type":"Note","content":"CURRENT","to":["urn:collection","urn:collection"],"bcc":["urn:blind"]}',
      activity:
        '{ "type":"Create", "object":{"type":"Note","content":"PAST EMBEDDED"} }',
    },
    {
      name: "embedded",
      object:
        '{"type":"Note","content":"private original","test:extra":[1,null,false]}',
      activity:
        '{"type":"Create","object":{"type":"Note","content":"private original","test:extra":[1,null,false]}}',
    },
    {
      name: "fetched",
      fetched: true,
      object: '{"type":"Note","content":"fetched original"}',
      activity:
        '{"type":"Create","object":"https://remote.example/notes/fetched"}',
    },
    { name: "unavailable", object: null, activity: null },
    {
      name: "unavailable-object",
      object: null,
      activity:
        '{"type":"Create","object":{"type":"Note","content":"retained in carrier only"}}',
    },
    { name: "json-null", object: "null", activity: "null" },
    { name: "scalar", object: '"legacy scalar"', activity: "42" },
    {
      name: "escaped-null",
      object: '{"type":"Note","content":"\\u0000"}',
      activity: '{"type":"Create","summary":"\\u0000","object":"urn:remote"}',
    },
    {
      name: "deleted",
      local: true,
      deleted: true,
      object: '{"type":"Note","content":"retained deleted object"}',
      activity:
        '{"type":"Create","object":{"type":"Note","content":"before deletion"}}',
    },
  ];
  const pairs: LegacyPair[] = [];
  for (const definition of definitions) {
    const objectId = uuidV7();
    const activityId = uuidV7();
    const origin = definition.local
      ? "https://revision-test.example"
      : "https://remote.example";
    const actor = definition.local ? localActor : remoteActor;
    await fixture.query(
      "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, 'object'), ($3, $4, 'activity')",
      [
        objectId,
        `${origin}/notes/${definition.name}`,
        activityId,
        `${origin}/ap/creates/${definition.name}`,
      ],
    );
    await fixture.query(
      `INSERT INTO objects
      (id, actor_id, activity_id, fetched, type, content_html, document, created, published, updated, deleted)
      VALUES ($1, $2, $3, $4::boolean, 'Note', 'legacy HTML', $5::json, $6::timestamptz, $6::timestamptz, $6::timestamptz, $7::timestamptz)`,
      [
        objectId,
        actor,
        activityId,
        Boolean(definition.fetched),
        definition.object,
        created,
        definition.deleted ? deleted : null,
      ],
    );
    await fixture.query(
      "INSERT INTO activities (id, actor_id, object_id, type, document, created, published) VALUES ($1, $2, $3, 'Create', $4::json, $5::timestamptz, $5::timestamptz)",
      [activityId, actor, objectId, definition.activity, created],
    );
    pairs.push({
      name: definition.name,
      objectId,
      activityId,
      objectDocument: definition.object,
      activityDocument: definition.activity,
      objectCapture: definition.local
        ? "local"
        : definition.fetched
          ? "fetched"
          : "embedded",
      activityCapture: definition.local ? "local" : "received",
      deleted: Boolean(definition.deleted),
    });
  }

  const collection = uuidV7();
  const blind = uuidV7();
  await fixture.query(
    "INSERT INTO resources (id, iri, kind) VALUES ($1, 'urn:collection', 'collection'), ($2, 'urn:blind', 'unknown')",
    [collection, blind],
  );
  await fixture.query(
    "INSERT INTO collections (id, type, owner_actor_id, total_items) VALUES ($1, 'OrderedCollection', $2, 2)",
    [collection, localActor],
  );
  const local = pairs.find(({ name }) => name === "local");
  const embedded = pairs.find(({ name }) => name === "embedded");
  const fetched = pairs.find(({ name }) => name === "fetched");
  const unavailableObject = pairs.find(
    ({ name }) => name === "unavailable-object",
  );
  assert.ok(local && embedded && fetched && unavailableObject);
  await fixture.query(
    "INSERT INTO collection_items (collection_id, item_id, position) VALUES ($1, $2, -3), ($1, $3, 7)",
    [collection, local.objectId, embedded.objectId],
  );
  for (const sourceId of [local.objectId, local.activityId]) {
    await fixture.query(
      "INSERT INTO addressing (id, source_id, property, position, target_id) VALUES ($1, $2, 'to', 0, $3), ($4, $2, 'to', 1, $3), ($5, $2, 'bcc', 0, $6)",
      [uuidV7(), sourceId, collection, uuidV7(), uuidV7(), blind],
    );
  }

  const embeddedDeliveryId = uuidV7();
  const fetchedDeliveryId = uuidV7();
  const unavailableObjectDeliveryId = uuidV7();
  await fixture.query(
    `INSERT INTO activity_deliveries
    (id, instance_id, direction, status, verification_result, activity_id, activity_iri, body, payload, fetched_object, carried_snapshot, carried_object_snapshot, inbox_url, completed)
    VALUES ($1, $2, 'inbound', 'received', 'verified', $3, 'https://remote.example/ap/creates/embedded', '\\x'::bytea, $4::jsonb, NULL, true, true, 'https://revision-test.example/inbox', now()),
      ($5, $2, 'inbound', 'received', 'verified', $6, 'https://remote.example/ap/creates/fetched', '\\x'::bytea, $7::jsonb, $8::jsonb, true, true, 'https://revision-test.example/inbox', now()),
      ($9, $2, 'inbound', 'received', 'verified', $10, 'https://remote.example/ap/creates/unavailable-object', '\\x'::bytea, $11::jsonb, NULL, true, true, 'https://revision-test.example/inbox', now())`,
    [
      embeddedDeliveryId,
      localInstance,
      embedded.activityId,
      embedded.activityDocument,
      fetchedDeliveryId,
      fetched.activityId,
      fetched.activityDocument,
      fetched.objectDocument,
      unavailableObjectDeliveryId,
      unavailableObject.activityId,
      unavailableObject.activityDocument,
    ],
  );
  await fixture.query(
    `INSERT INTO activity_deliveries
    (id, instance_id, direction, status, verification_result, activity_id, activity_iri, body, payload, carried_snapshot, carried_object_snapshot, inbox_url, completed)
    VALUES ($1, $2, 'inbound', 'received', 'verified', $3, 'https://remote.example/ap/creates/embedded', '\\x'::bytea, '{"type":"Create","object":"urn:different-version"}'::jsonb, false, false, 'https://revision-test.example/inbox', now()),
      ($4, $2, 'outbound', 'sent', NULL, $5, 'https://revision-test.example/ap/creates/local', NULL, NULL, true, true, 'https://remote.example/inbox', now())`,
    [uuidV7(), localInstance, embedded.activityId, uuidV7(), local.activityId],
  );
  return {
    pairs,
    embeddedDeliveryId,
    fetchedDeliveryId,
    unavailableObjectDeliveryId,
  };
}

async function legacyState(fixture: RevisionFixture) {
  const statements = {
    resources: "SELECT id, iri, kind FROM resources ORDER BY id",
    objects:
      "SELECT id, actor_id, activity_id, fetched, type, content_html, document::text AS document, created::text, updated::text, published::text, deleted::text FROM objects ORDER BY id",
    activities:
      "SELECT id, actor_id, object_id, type, document::text AS document, created::text, published::text FROM activities ORDER BY id",
    addressing:
      "SELECT id, source_id, property, position, target_id FROM addressing ORDER BY id",
    collections:
      "SELECT id, type, owner_actor_id, total_items, document::text AS document FROM collections ORDER BY id",
    members:
      "SELECT collection_id, item_id, position, observed::text FROM collection_items ORDER BY collection_id, position",
    deliveries:
      "SELECT id, instance_id, activity_id, direction, status, verification_result, carried_snapshot, carried_object_snapshot, payload::text AS payload, fetched_object::text AS fetched_object FROM activity_deliveries ORDER BY id",
  };
  const result: Record<string, unknown> = {};
  for (const [name, statement] of Object.entries(statements)) {
    result[name] = (await fixture.query(statement)).rows;
  }
  return result;
}

async function normalizedHistory(
  fixture: RevisionFixture,
  pairs: readonly LegacyPair[],
) {
  const result: Record<string, unknown> = {};
  for (const pair of pairs) {
    for (const [role, resourceId] of [
      ["object", pair.objectId],
      ["activity", pair.activityId],
    ] as const) {
      result[`${pair.name}:${role}`] = (
        await fixture.query(
          `SELECT revision.sequence, revision.kind, revision.capture,
        revision.document::text AS document, revision.former_types,
        to_char(revision.deleted AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted,
        revision.projection,
        ARRAY(SELECT property::text || ':' || position::text || ':' || iri FROM revision_addressing WHERE revision_id=revision.id ORDER BY property, position) AS addressing
        FROM resource_revisions AS revision WHERE resource_id=$1 ORDER BY sequence`,
          [resourceId],
        )
      ).rows;
    }
  }
  return result;
}

function isLegacyConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const failure = current as {
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (
      failure.constraint === "resource_revisions_legacy_guard" ||
      failure.constraint_name === "resource_revisions_legacy_guard"
    ) {
      return true;
    }
    current = failure.cause;
  }
  return false;
}

for (const backend of revisionBackends) {
  it(
    `preserves pre-revision data and matches runtime legacy capture on ${backend}`,
    { skip: backend === "postgres" && !revisionPostgresUrl },
    async () => {
      let migratedHistory: Record<string, unknown> | undefined;
      await withRevisionDatabase(
        backend,
        async (fixture) => {
          const legacy = await seedLegacy(fixture);
          const before = await legacyState(fixture);
          await fixture.upgrade();
          assert.deepEqual(await legacyState(fixture), before);
          migratedHistory = await normalizedHistory(fixture, legacy.pairs);
          for (const pair of legacy.pairs) {
            for (const [role, resourceId, document, capture] of [
              [
                "object",
                pair.objectId,
                pair.objectDocument,
                pair.objectCapture,
              ],
              [
                "activity",
                pair.activityId,
                pair.activityDocument,
                pair.activityCapture,
              ],
            ] as const) {
              const current = await loadCurrentResourceRevision(
                fixture.db,
                resourceId,
              );
              assert.ok(current);
              assert.equal(
                current.kind,
                role === "object" && pair.deleted
                  ? "whiteout"
                  : document === null
                    ? "unavailable"
                    : "snapshot",
              );
              assert.equal(current.capture, capture);
              assert.equal(current.backfilled, true);
              assert.equal(current.projection, "partial");
              assert.deepEqual(current.relations, []);
              const first = (
                await fixture.query<{ id: Uuid }>(
                  "SELECT id FROM resource_revisions WHERE resource_id=$1 AND sequence=1",
                  [resourceId],
                )
              ).rows[0];
              assert.ok(first);
              const original = await loadResourceRevision(fixture.db, first.id);
              assert.ok(original);
              assert.equal(
                original.kind,
                document === null ? "unavailable" : "snapshot",
              );
              assert.deepEqual(
                original.document,
                document === null ? null : JSON.parse(document),
              );
              assert.equal(
                original.created.equals(Temporal.Instant.from(created)),
                true,
              );
              assert.deepEqual(
                original.addressing.map(({ property, position, iri }) => [
                  property,
                  position,
                  iri,
                ]),
                pair.name === "local"
                  ? [
                      ["to", 0, "urn:collection"],
                      ["to", 1, "urn:collection"],
                      ["bcc", 0, "urn:blind"],
                    ]
                  : [],
              );
              if (role === "object" && pair.deleted) {
                assert.equal(current.sequence, 2);
                assert.deepEqual(current.formerTypes, ["Note"]);
                assert.equal(
                  current.deleted?.equals(Temporal.Instant.from(deleted)),
                  true,
                );
                assert.equal(
                  current.created.equals(Temporal.Instant.from(deleted)),
                  true,
                );
              }
            }
          }
          const receipts = (
            await fixture.query<{ delivery_id: string; role: string }>(
              "SELECT delivery_id, role FROM revision_receipts ORDER BY delivery_id, role",
            )
          ).rows;
          assert.deepEqual(
            receipts,
            [
              ...[legacy.embeddedDeliveryId, legacy.fetchedDeliveryId].flatMap(
                (delivery_id) => [
                  { delivery_id, role: "activity" },
                  { delivery_id, role: "object" },
                ],
              ),
              {
                delivery_id: legacy.unavailableObjectDeliveryId,
                role: "activity",
              },
            ].toSorted(
              (left, right) =>
                left.delivery_id.localeCompare(right.delivery_id) ||
                left.role.localeCompare(right.role),
            ),
          );
          assert.equal(
            (await fixture.query("SELECT * FROM revision_relations")).rows
              .length,
            0,
          );
          const local = legacy.pairs.find(({ name }) => name === "local");
          assert.ok(local);
          // The current object says CURRENT; the old Create must keep PAST EMBEDDED.
          assert.deepEqual(
            (await loadCurrentResourceRevision(fixture.db, local.activityId))
              ?.document,
            JSON.parse(local.activityDocument ?? "null"),
          );
        },
        { beforeMigration },
      );
      assert.ok(migratedHistory);

      await withRevisionDatabase(backend, async (fixture) => {
        const legacy = await seedLegacy(fixture);
        const before = await legacyState(fixture);
        const resources = (
          await fixture.query<{ id: Uuid }>(
            "SELECT registry.id FROM resources AS registry WHERE registry.kind IN ('object','activity') ORDER BY registry.iri",
          )
        ).rows;
        const firstRevisions = new Map<Uuid, Uuid>();
        await fixture.db.transaction(async (tx) => {
          for (const { id } of resources) {
            firstRevisions.set(id, await captureLegacyResourceRevision(tx, id));
          }
        });
        assert.deepEqual(await legacyState(fixture), before);
        assert.deepEqual(
          await normalizedHistory(fixture, legacy.pairs),
          migratedHistory,
        );
        const revisionCount = (
          await fixture.query("SELECT * FROM resource_revisions")
        ).rows.length;
        await fixture.db.transaction(async (tx) => {
          for (const { id } of resources) {
            assert.equal(
              await captureLegacyResourceRevision(tx, id),
              firstRevisions.get(id),
            );
          }
        });
        assert.equal(
          (await fixture.query("SELECT * FROM resource_revisions")).rows.length,
          revisionCount,
        );
        for (const pair of legacy.pairs) {
          assert.equal(
            (
              await loadResourceRevision(
                fixture.db,
                firstRevisions.get(pair.objectId)!,
              )
            )?.backfilled,
            false,
          );
        }
        const pair = legacy.pairs.find(({ name }) => name === "local");
        assert.ok(pair);
        const head = await loadCurrentResourceRevision(
          fixture.db,
          pair.objectId,
        );
        await fixture.query(
          'UPDATE objects SET document=\'{"type":"Note","content":"unsupported rewrite"}\'::json WHERE id=$1',
          [pair.objectId],
        );
        await assert.rejects(
          fixture.query(
            "SELECT drfed_capture_legacy_resource($1::uuid, false)",
            [pair.objectId],
          ),
          isLegacyConflict,
        );
        await assert.rejects(
          fixture.db.transaction((tx) =>
            captureLegacyResourceRevision(tx, pair.objectId),
          ),
          (error: unknown) =>
            error instanceof LegacyResourceRevisionError &&
            error.resourceId === pair.objectId,
        );
        assert.equal(
          (await loadCurrentResourceRevision(fixture.db, pair.objectId))?.id,
          head?.id,
        );
        assert.deepEqual(
          (await loadCurrentResourceRevision(fixture.db, pair.objectId))
            ?.document,
          JSON.parse(pair.objectDocument ?? "null"),
        );
      });
    },
  );
}
