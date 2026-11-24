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

import type { Database } from "@drfed/models";
import {
  loadCurrentResourceRevision,
  loadRevisionExpansion,
} from "@drfed/models/resource-revision";
import type { Uuid } from "@drfed/models/uuid";

import { withTestHarness } from "../harness.test.ts";
import { seedLocalInstance } from "../seed.test.ts";
import {
  type Documents,
  addActor,
  createOf,
  createRecorder,
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
