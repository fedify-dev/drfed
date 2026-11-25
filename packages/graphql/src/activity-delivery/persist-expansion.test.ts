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

import { backfillExpansions } from "@drfed/federation/expansion-backfill";
import { type Database, schema } from "@drfed/models";
import { ensureResource } from "@drfed/models/resource";
import {
  appendResourceRevision,
  captureLegacyResourceRevision,
  loadCurrentResourceRevision,
  loadRevisionExpansion,
} from "@drfed/models/resource-revision";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";
import { type DocumentLoader, signRequest } from "@fedify/fedify";
import { eq, sql } from "drizzle-orm";

import { withTestHarness } from "../harness.test.ts";
import { seedLocalInstance } from "../seed.test.ts";
import {
  type Documents,
  addActor,
  createOf,
  createRecorder,
  hostA,
  idOf,
  signed,
} from "./inbox-fixture.test.ts";

const alice = "https://remote.example/users/alice";
const AS = "https://www.w3.org/ns/activitystreams";
const NS = "https://remote.example/ns";
const MOOD = `${NS}#mood`;

// A context outside the offline allowlist, served by the actor's server.
const contexts: Documents = new Map([
  [NS, { "@context": { mood: MOOD, Hashtag: "as:Hashtag" } }],
]);

async function expansionOf(db: Database, resourceId: Uuid) {
  const revision = await loadCurrentResourceRevision(db, resourceId);
  assert.ok(revision !== null, "the resource has a revision");
  const expansion = await loadRevisionExpansion(db, revision.id);
  assert.ok(expansion !== null, "the revision has an expansion");
  return { revision, expansion };
}

const nodeOf = (document: unknown): Record<string, unknown> => {
  assert.ok(Array.isArray(document));
  const [node] = document as unknown[];
  assert.ok(node !== null && typeof node === "object");
  return node as Record<string, unknown>;
};

it("expands a received Create and its embedded object with remote contexts", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const { send } = await createRecorder(db, documents, { contexts });
    const body = createOf(alice, "1", {
      activity: { "@context": [AS, NS], mood: "happy", outerOnly: 1 },
      object: {
        mood: "calm",
        bogus: 1,
        tag: [{ type: "Hashtag", name: "#drfed" }],
      },
    });
    assert.equal((await send(await signed(signer, body))).status, 202);

    const activityId = await idOf(db, "https://remote.example/activities/1");
    const objectId = await idOf(db, "https://remote.example/notes/1");
    const activity = await expansionOf(db, activityId);
    assert.equal(activity.revision.capture, "received");
    assert.equal(activity.expansion.outcome, "expanded");
    assert.equal(activity.expansion.sourceRevisionId, null);
    assert.deepEqual(nodeOf(activity.expansion.document)[MOOD], [
      { "@value": "happy" },
    ]);
    assert.deepEqual(activity.expansion.undefinedTerms, ["bogus", "outerOnly"]);

    const object = await expansionOf(db, objectId);
    assert.equal(object.revision.capture, "embedded");
    assert.equal(object.expansion.outcome, "expanded");
    // Taken from the activity, under the context the object inherits.
    assert.equal(object.expansion.sourceRevisionId, activity.revision.id);
    const node = nodeOf(object.expansion.document);
    assert.equal(node["@id"], "https://remote.example/notes/1");
    assert.deepEqual(node[MOOD], [{ "@value": "calm" }]);
    assert.deepEqual(node[`${AS}#tag`], [
      { "@type": [`${AS}#Hashtag`], [`${AS}#name`]: [{ "@value": "#drfed" }] },
    ]);
    assert.deepEqual(object.expansion.undefinedTerms, ["bogus"]);
    assert.deepEqual(object.expansion.droppedTerms, []);

    // Another Create of the stored object keeps the object's expansion.
    const again = createOf(alice, "2", {
      object: { id: "https://remote.example/notes/1", content: "<p>2</p>" },
    });
    assert.equal((await send(await signed(signer, again))).status, 202);
    const second = await expansionOf(
      db,
      await idOf(db, "https://remote.example/activities/2"),
    );
    assert.equal(second.expansion.outcome, "expanded");
    assert.deepEqual(await expansionOf(db, objectId), object);
  });
});

it("expands a fetched object on its own", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    documents.set("https://remote.example/notes/fetched", {
      "@context": [AS, NS],
      id: "https://remote.example/notes/fetched",
      type: "Note",
      attributedTo: alice,
      content: "<p>fetched</p>",
      mood: "far",
    });
    const { send } = await createRecorder(db, documents, { contexts });
    const body = createOf(alice, "fetched", {
      object: "https://remote.example/notes/fetched",
    });
    assert.equal((await send(await signed(signer, body))).status, 202);
    const object = await expansionOf(
      db,
      await idOf(db, "https://remote.example/notes/fetched"),
    );
    assert.equal(object.revision.capture, "fetched");
    assert.equal(object.expansion.outcome, "expanded");
    assert.equal(object.expansion.sourceRevisionId, null);
    const node = nodeOf(object.expansion.document);
    assert.equal(node["@id"], "https://remote.example/notes/fetched");
    assert.deepEqual(node[`${AS}#content`], [{ "@value": "<p>fetched</p>" }]);
  });
});

it("backfills the expansions of revisions without one", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const { send } = await createRecorder(db, documents, { contexts });
    const body = createOf(alice, "1", {
      activity: { "@context": [AS, NS], mood: "happy" },
      object: { mood: "calm", bogus: 1 },
    });
    assert.equal((await send(await signed(signer, body))).status, 202);
    const activityId = await idOf(db, "https://remote.example/activities/1");
    const objectId = await idOf(db, "https://remote.example/notes/1");
    const before = [
      await expansionOf(db, activityId),
      await expansionOf(db, objectId),
    ];
    const contextLoader: DocumentLoader = (url) =>
      contexts.has(url)
        ? Promise.resolve({
            contextUrl: null,
            documentUrl: url,
            document: contexts.get(url),
          })
        : Promise.reject(new Error(`offline: ${url}`));

    // As if stored before expansions were.
    await db.delete(schema.revisionExpansions);
    assert.deepEqual(await backfillExpansions(db, { contextLoader }), {
      expanded: 2,
      failed: 0,
      noDocument: 0,
    });
    assert.deepEqual(
      [await expansionOf(db, activityId), await expansionOf(db, objectId)],
      before,
    );
    // Running again records nothing.
    assert.deepEqual(await backfillExpansions(db, { contextLoader }), {
      expanded: 0,
      failed: 0,
      noDocument: 0,
    });

    // An embedded object whose carrying activity cannot be found fails.
    await db
      .update(schema.objects)
      .set({ activityId: null })
      .where(eq(schema.objects.id, objectId));
    await db
      .delete(schema.revisionExpansions)
      .where(eq(schema.revisionExpansions.revisionId, before[1]!.revision.id));
    assert.deepEqual(await backfillExpansions(db, { contextLoader }), {
      expanded: 0,
      failed: 1,
      noDocument: 0,
    });
    const { expansion } = await expansionOf(db, objectId);
    assert.equal(expansion.outcome, "failed");
    assert.match(expansion.failure ?? "", /carried the object/u);
  });
});

it("stores a received document with a number beyond the double range", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const { send } = await createRecorder(db, documents);
    // JSON.parse reads 1e400 as Infinity, which documents store as null.
    const text = JSON.stringify(
      createOf(alice, "huge", { object: { width: 7 } }),
    ).replace('"width":7', '"width":1e400');
    assert.match(text, /"width":1e400/u);
    const request = new Request(`https://${hostA}/inbox`, {
      method: "POST",
      headers: { "content-type": "application/activity+json" },
      body: text,
    });
    const response = await send(
      await signRequest(request, signer.privateKey, signer.keyId),
    );
    assert.equal(response.status, 202);
    const activity = await expansionOf(
      db,
      await idOf(db, "https://remote.example/activities/huge"),
    );
    const object = await expansionOf(
      db,
      await idOf(db, "https://remote.example/notes/huge"),
    );
    // The expansions are of the documents as stored, where width is null.
    assert.equal(
      (object.revision.document as { readonly width?: unknown } | null)?.width,
      null,
    );
    for (const { expansion } of [activity, object]) {
      assert.equal(expansion.outcome, "expanded");
      assert.doesNotMatch(JSON.stringify(expansion.document), /width/u);
    }
  });
});

const loaderFor =
  (served: Documents): DocumentLoader =>
  (url) =>
    served.has(url)
      ? Promise.resolve({
          contextUrl: null,
          documentUrl: url,
          document: served.get(url),
        })
      : Promise.reject(new Error(`offline: ${url}`));

it("backfills an embedded object from its activity's recorded expansion", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const ALIAS = "https://remote.example/alias";
    const served: Documents = new Map([
      [ALIAS, { "@context": { payload: "as:object" } }],
    ]);
    const { send } = await createRecorder(db, documents, { contexts: served });
    // The activity names its object through an alias a remote context defines.
    const { object, ...rest } = createOf(alice, "aliased");
    const body = { ...rest, "@context": [AS, ALIAS], payload: object };
    assert.equal((await send(await signed(signer, body))).status, 202);
    const objectId = await idOf(db, "https://remote.example/notes/aliased");
    const before = await expansionOf(db, objectId);
    assert.equal(before.expansion.outcome, "expanded");

    // The alias changes before the object's row is backfilled.
    await db
      .delete(schema.revisionExpansions)
      .where(eq(schema.revisionExpansions.revisionId, before.revision.id));
    const changed: Documents = new Map([
      [ALIAS, { "@context": { payload: "urn:example:other" } }],
    ]);
    assert.deepEqual(
      await backfillExpansions(db, { contextLoader: loaderFor(changed) }),
      { expanded: 1, failed: 0, noDocument: 0 },
    );
    const after = await expansionOf(db, objectId);
    assert.deepEqual(after.expansion, {
      ...before.expansion,
      // Found only through the recorded node, so no terms are counted.
      droppedTerms: [],
    });
  });
});

it("counts a backfilled expansion JSON cannot hold as failed", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const { send } = await createRecorder(db, documents);
    const body = createOf(alice, "base");
    assert.equal((await send(await signed(signer, body))).status, 202);
    const actorId = await idOf(db, alice);
    // A legacy fetched object whose stored JSON holds a number beyond the
    // double range, which the driver reads as Infinity.
    const iri = "https://remote.example/notes/huge";
    const resource = { id: uuidV7() };
    await db.execute(
      sql`INSERT INTO resources (id, iri, kind) VALUES (${resource.id}, ${iri}, 'object')`,
    );
    await db.execute(sql`
      INSERT INTO objects (id, actor_id, type, content_html, fetched, document)
      VALUES (${resource.id}, ${actorId}, 'Note', 'huge', true,
        ${`{"@context":"${AS}","id":"${iri}","type":"Note","width":1e400}`}::json)`);
    await db.transaction(
      async (tx) => await captureLegacyResourceRevision(tx, resource.id),
    );
    assert.deepEqual(
      await backfillExpansions(db, { contextLoader: loaderFor(new Map()) }),
      { expanded: 0, failed: 1, noDocument: 0 },
    );
    const { expansion } = await expansionOf(db, resource.id);
    assert.equal(expansion.outcome, "failed");
    assert.match(expansion.failure ?? "", /cannot be stored as JSON/u);
  });
});

it("retries a context that failed to load, up to three times a run", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const FLAKY = "https://flaky.example/context";
    const DEAD = "https://dead.example/context";
    for (const [host, context] of [
      ["flaky", FLAKY],
      ["dead", DEAD],
    ] as const) {
      // Revisions are appended in order, so that the backfill meets them so.
      for (let index = 0; index < 5; index += 1) {
        // oxlint-disable-next-line no-await-in-loop
        const resource = await ensureResource(
          db,
          `https://${host}.example/notes/${index}`,
        );
        // oxlint-disable-next-line no-await-in-loop
        await appendResourceRevision(db, {
          resourceId: resource.id,
          resourceKind: "object",
          expectedRevisionId: null,
          kind: "snapshot",
          document: { "@context": [AS, context], type: "Note", mood: "x" },
          capture: "fetched",
          expansion: { outcome: "failed", failure: "not yet expanded" },
        });
      }
    }
    await db.delete(schema.revisionExpansions);
    const calls = new Map<string, number>();
    const contextLoader: DocumentLoader = (url) => {
      const count = (calls.get(url) ?? 0) + 1;
      calls.set(url, count);
      // The flaky server fails once, the dead one always.
      if (url === DEAD || (url === FLAKY && count === 1)) {
        return Promise.reject(new Error(`unreachable: ${url}`));
      }
      return Promise.resolve({
        contextUrl: null,
        documentUrl: url,
        document: { "@context": { mood: MOOD } },
      });
    };
    assert.deepEqual(await backfillExpansions(db, { contextLoader }), {
      expanded: 4,
      failed: 6,
      noDocument: 0,
    });
    // A failure is retried for the next revision; success is reused.
    assert.equal(calls.get(FLAKY), 2);
    // A context failing three times is not loaded again in the run.
    assert.equal(calls.get(DEAD), 3);
  });
});
