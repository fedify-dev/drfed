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

// Writes in one test depend on the state the previous ones left.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";

import {
  type JsonObject,
  type LocalWriteEnvironment,
  type LocalWriteRequest,
  type NewResource,
  type SavedResource,
  commitLocalWrite,
  createLegacyObject,
  isLocalWriteError,
  previewLocalWrite,
} from "@drfed/federation/local-write";
import {
  loadActivitySnapshot,
  parseVocab,
  publicDocument,
} from "@drfed/federation/serving";
import { type Database, schema } from "@drfed/models";
import {
  PUBLIC_IRI,
  addActorCollectionItem,
  ensureResource,
  storeAddressingOccurrences,
} from "@drfed/models/resource";
import {
  appendResourceRevision,
  loadCurrentResourceRevision,
} from "@drfed/models/resource-revision";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";
import type { Federation } from "@fedify/fedify";
import { Like, OrderedCollectionPage, getTypeId } from "@fedify/vocab";
import { describe, it } from "@logtape/testing-node/autoload";
import { eq } from "drizzle-orm";

import { withFederation } from "./harness.test.ts";
import {
  created,
  expires,
  localActorId,
  localInstanceId,
  seedActors,
  seedLocalActor,
} from "./seed.test.ts";
import {
  acceptedActivityTypeIds,
  activityTypes,
  blindRecipient,
  extensionValue,
  typeDocument,
} from "./serving-fixture.test.ts";

const AS = "https://www.w3.org/ns/activitystreams";
const accountId = "00000000-0000-4000-8000-000000000301" as Uuid;
const principal = { accountId };
const host = "test-instance.drfed.org";
const actorIri = `https://${host}/users/${localActorId}`;
const blind = "https://remote.example/users/blind";
const bob = "https://remote.example/users/bob";

type Harness = Parameters<Parameters<typeof withFederation>[0]>[0];

async function setUp(harness: Harness): Promise<LocalWriteEnvironment> {
  await seedLocalActor(harness.db, { keys: false });
  await harness.db.insert(schema.accounts).values({
    id: accountId,
    email: "member@example.com",
    name: "Member",
    created,
  });
  await harness.db.insert(schema.instanceMembers).values({
    accountId,
    instanceId: localInstanceId,
    accepted: created,
    created,
  });
  return {
    db: harness.db,
    federation: harness.federation,
    rootOrigin: new URL("https://drfed.org"),
    previewKey: await crypto.subtle.generateKey(
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    ),
  };
}

async function write(
  env: LocalWriteEnvironment,
  request: LocalWriteRequest,
): Promise<readonly SavedResource[]> {
  const preview = await previewLocalWrite(env, principal, request);
  assert.ok(preview.ok, JSON.stringify(!preview.ok && preview.error));
  const outcome = await commitLocalWrite(env, principal, request, {
    previewToken: preview.preview.token,
    reserveDispatch: () => Promise.resolve(),
  });
  assert.ok(outcome.ok, JSON.stringify(!outcome.ok && outcome.error));
  return outcome.result.resources;
}

/**
 * Saves a document as a new root resource, with optional nested resources.
 * @returns The saved root, last of the saved resources.
 */
async function save(
  env: LocalWriteEnvironment,
  document: JsonObject,
  kind: NewResource["kind"],
  options: { nested?: NewResource[]; publish?: boolean } = {},
): Promise<SavedResource> {
  const resources = await write(env, {
    operation: "create",
    actorId: localActorId,
    document,
    resources: [{ path: [], kind }, ...(options.nested ?? [])],
    publish: options.publish ?? kind === "activity",
  });
  return resources.at(-1)!;
}

async function head(db: Database, id: Uuid) {
  const revision = await loadCurrentResourceRevision(db, id);
  assert.ok(revision != null);
  return revision;
}

async function edit(
  env: LocalWriteEnvironment,
  objectId: Uuid,
  change: (document: JsonObject) => JsonObject,
): Promise<SavedResource> {
  const current = await head(env.db, objectId);
  const [, update] = await write(env, {
    operation: "edit",
    actorId: localActorId,
    objectId,
    expectedRevisionId: current.id,
    document: change(current.document as JsonObject),
  });
  return update!;
}

async function remove(
  env: LocalWriteEnvironment,
  objectId: Uuid,
): Promise<SavedResource> {
  const current = await head(env.db, objectId);
  const [deletion] = await write(env, {
    operation: "delete",
    actorId: localActorId,
    objectId,
    expectedRevisionId: current.id,
  });
  return deletion!;
}

async function get(
  federation: Federation<unknown>,
  iri: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await federation.fetch(
    new Request(iri, { headers: { accept: "application/activity+json" } }),
    { contextData: undefined },
  );
  // Fedify answers a Tombstone with 410 and the document as its body.
  return {
    status: response.status,
    body: response.ok || response.status === 410 ? await response.json() : {},
  };
}

/**
 * Requests a resource away from its live actor's instance: on a host that is
 * no instance, on another instance's authority, or after the actor is
 * deleted.
 * @returns The IRI each resource is then requested at.
 */
async function misdirect(
  harness: Harness,
  scenario: "wrongHost" | "otherInstance" | "deletedActor",
): Promise<(iri: string) => string> {
  if (scenario === "wrongHost") {
    return (iri) => iri.replace(host, "wrong.example");
  }
  if (scenario === "otherInstance") {
    const id = uuidV7();
    await harness.db
      .insert(schema.localInstances)
      .values({ id, slug: "other-instance", expires });
    await harness.db.insert(schema.instances).values({
      id,
      localId: id,
      created,
      host: "other-instance.drfed.org",
    });
    return (iri) => iri.replace(host, "other-instance.drfed.org");
  }
  await harness.db
    .update(schema.actors)
    .set({ deleted: Temporal.Now.instant() })
    .where(eq(schema.actors.id, localActorId));
  return (iri) => iri;
}

/**
 * Finds every key spelled `bto` or `bcc` anywhere in a document.
 * @returns The keys, in document order.
 */
function blindKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(blindKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(key === "bto" || key === "bcc" ? [key] : []),
    ...blindKeys(entry),
  ]);
}

describe("publicDocument()", () => {
  it("removes blind recipients and keeps the other addressing in order", () => {
    const document = {
      "@context": AS,
      id: "https://a.example/notes/1",
      type: "Note",
      content: "x",
      to: [PUBLIC_IRI, bob],
      bto: [blind],
      cc: [`${actorIri}/followers`],
      bcc: blind,
      audience: "https://a.example/groups/1",
    };
    const copy = structuredClone(document);
    assert.deepEqual(publicDocument(document), {
      "@context": AS,
      id: "https://a.example/notes/1",
      type: "Note",
      content: "x",
      to: [PUBLIC_IRI, bob],
      cc: [`${actorIri}/followers`],
      audience: "https://a.example/groups/1",
    });
    assert.deepEqual(document, copy);
  });

  it("removes blind recipients from embedded documents at every depth", () => {
    const document = {
      "@context": AS,
      id: "https://a.example/activities/1",
      type: "Undo",
      actor: actorIri,
      to: [PUBLIC_IRI],
      bcc: [blind],
      object: {
        id: "https://a.example/activities/2",
        type: "Like",
        actor: actorIri,
        bto: [blind],
        object: {
          id: "https://a.example/notes/1",
          type: "Note",
          content: "x",
          bcc: [blind],
        },
      },
    };
    const result = publicDocument(document);
    assert.deepEqual(blindKeys(result), []);
    assert.deepEqual(result, {
      "@context": AS,
      id: "https://a.example/activities/1",
      type: "Undo",
      actor: actorIri,
      to: [PUBLIC_IRI],
      object: {
        id: "https://a.example/activities/2",
        type: "Like",
        actor: actorIri,
        object: {
          id: "https://a.example/notes/1",
          type: "Note",
          content: "x",
        },
      },
    });
  });

  it("removes blind recipients by meaning, whatever their spelling", () => {
    const context = [
      AS,
      {
        hidden: { "@id": "as:bcc", "@type": "@id" },
        secret: { "@id": `${AS}#bto`, "@type": "@id" },
      },
    ];
    const result = publicDocument({
      "@context": context,
      id: "https://a.example/notes/1",
      type: "Note",
      content: "x",
      to: [PUBLIC_IRI],
      hidden: [blind],
      secret: blind,
    });
    assert.deepEqual(result, {
      "@context": context,
      id: "https://a.example/notes/1",
      type: "Note",
      content: "x",
      to: [PUBLIC_IRI],
    });
  });

  it("keeps the context and extension values without their blind recipients", () => {
    const context = [
      AS,
      { ex: "https://ext.example/ns#", mood: "ex:mood" },
    ] as const;
    const literal = { "@type": "@json", "@value": { bcc: ["kept"] } };
    const document = {
      "@context": [...context],
      id: "https://a.example/activities/1",
      type: "Like",
      actor: actorIri,
      object: "https://remote.example/notes/1",
      mood: { bcc: [blind], deep: [1, "x", null, { bto: blind }], literal },
      bcc: [blind],
    };
    assert.deepEqual(publicDocument(document), {
      "@context": [...context],
      id: "https://a.example/activities/1",
      type: "Like",
      actor: actorIri,
      object: "https://remote.example/notes/1",
      mood: { deep: [1, "x", null, {}], literal },
    });
    // Blind recipients are found by IRI, whatever their container, and a
    // JSON literal stays as saved, however its keywords are spelled.
    const listed = [
      ...context,
      {
        hidden: { "@id": "as:bcc", "@type": "@id", "@container": "@list" },
      },
    ];
    const typed = { type: "@json", "@value": { bcc: ["kept"], "@id": 1 } };
    assert.deepEqual(
      publicDocument({
        ...document,
        "@context": listed,
        mood: { hidden: [blind], typed },
      }),
      {
        "@context": listed,
        id: "https://a.example/activities/1",
        type: "Like",
        actor: actorIri,
        object: "https://remote.example/notes/1",
        mood: { typed },
      },
    );
    // The validator does not read a context inside an extension value.
    assert.equal(
      publicDocument({
        ...document,
        mood: { "@context": { secret: "as:bcc" }, secret: [blind] },
      }),
      null,
    );
  });

  it("refuses a document the validator cannot read offline", () => {
    assert.equal(
      publicDocument({
        "@context": [AS, "https://gotosocial.org/ns"],
        id: "https://a.example/notes/1",
        type: "Note",
        content: "x",
        bcc: [blind],
      }),
      null,
    );
  });
});

describe("federation reads of saved activities", () => {
  const fixtures: {
    name: string;
    document: JsonObject;
    nested?: NewResource[];
    route: "creates" | "activities";
    check?: (body: Record<string, unknown>) => void;
  }[] = [
    {
      name: "Create with an embedded Note",
      document: {
        "@context": AS,
        type: "Create",
        to: [PUBLIC_IRI],
        bcc: [blind],
        object: { type: "Note", content: "x", to: [PUBLIC_IRI], bcc: [blind] },
      },
      nested: [{ path: ["object"], kind: "object" }],
      route: "creates",
      check: (body) => assert.equal(typeof body.object, "object"),
    },
    {
      name: "Create referring to a new Note",
      document: {
        "@context": AS,
        type: "Create",
        to: [PUBLIC_IRI],
        object: { type: "Note", content: "x", to: [PUBLIC_IRI] },
      },
      nested: [
        { path: ["object"], kind: "object", representation: "reference" },
      ],
      route: "creates",
      check: (body) =>
        assert.ok(
          String(body.object).startsWith(`${actorIri}/`),
          String(body.object),
        ),
    },
    {
      name: "Undo of a new Like of a remote Note",
      document: {
        "@context": AS,
        type: "Undo",
        to: [PUBLIC_IRI],
        object: { type: "Like", object: "https://remote.example/notes/1" },
      },
      nested: [{ path: ["object"], kind: "activity" }],
      route: "activities",
      check: (body) =>
        assert.equal(
          (body.object as { object: unknown }).object,
          "https://remote.example/notes/1",
        ),
    },
    {
      name: "Accept of a remote Follow",
      document: {
        "@context": AS,
        type: "Accept",
        to: [bob],
        cc: [PUBLIC_IRI],
        object: {
          id: "https://remote.example/follows/1",
          type: "Follow",
          actor: bob,
          object: actorIri,
        },
      },
      route: "activities",
      check: (body) =>
        assert.equal((body.object as { actor: unknown }).actor, bob),
    },
    {
      name: "Add to a collection target",
      document: {
        "@context": AS,
        type: "Add",
        to: [PUBLIC_IRI],
        object: "https://remote.example/notes/1",
        target: `${actorIri}/featured`,
      },
      route: "activities",
      check: (body) => assert.equal(body.target, `${actorIri}/featured`),
    },
    {
      name: "Arrive without an object",
      document: {
        "@context": AS,
        type: "Arrive",
        to: [PUBLIC_IRI],
        location: "https://remote.example/places/1",
      },
      route: "activities",
      check: (body) => {
        assert.equal(body.object, undefined);
        assert.equal(body.location, "https://remote.example/places/1");
      },
    },
    {
      name: "Like with an extension property",
      document: {
        "@context": [AS, { ex: "https://ext.example/ns#", mood: "ex:mood" }],
        type: "Like",
        to: [PUBLIC_IRI],
        bto: [blind],
        object: "https://remote.example/notes/1",
        mood: { deep: [1, "x"] },
      },
      route: "activities",
      check: (body) => assert.deepEqual(body.mood, { deep: [1, "x"] }),
    },
    {
      name: "Question saved as an activity",
      document: {
        "@context": AS,
        type: "Question",
        name: "q",
        to: [PUBLIC_IRI],
      },
      route: "activities",
    },
  ];
  for (const { name, document, nested, route, check } of fixtures) {
    it(`serves ${name} as saved, without blind recipients`, async () => {
      await withFederation(async (harness) => {
        const env = await setUp(harness);
        const saved = await save(env, document, "activity", {
          ...(nested == null ? {} : { nested }),
        });
        assert.ok(
          saved.iri.startsWith(`https://${host}/ap/${route}/`),
          saved.iri,
        );
        const { status, body } = await get(harness.federation, saved.iri);
        assert.equal(status, 200);
        assert.deepEqual(body, publicDocument(saved.document));
        assert.deepEqual(blindKeys(body), []);
        check?.(body);
        const other = saved.iri.replace(
          `/ap/${route}/`,
          route === "creates" ? "/ap/activities/" : "/ap/creates/",
        );
        assert.equal((await get(harness.federation, other)).status, 404);
      });
    });
  }

  it("covers every activity type the validator accepts", () => {
    assert.deepEqual(
      acceptedActivityTypeIds(),
      activityTypes.map((type) => `${AS}#${type}`).toSorted(),
    );
  });

  it("serves every activity type as saved, at its route and in the outbox", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const ctx = harness.federation.createContext(
        new URL(`https://${host}/`),
        undefined,
      );
      const iris: string[] = [];
      for (const type of activityTypes) {
        const saved = await save(env, typeDocument(type), "activity");
        const route = type === "Create" ? "creates" : "activities";
        assert.ok(
          saved.iri.startsWith(`https://${host}/ap/${route}/`),
          `${type}: ${saved.iri}`,
        );
        // Stored with its blind recipient, so that serving has one to remove.
        const stored = await loadActivitySnapshot(harness.db, saved.id);
        assert.ok(stored != null, type);
        assert.deepEqual(stored.document, saved.document, type);
        assert.deepEqual(stored.document.bto, [blindRecipient], type);
        const served = publicDocument(stored.document);
        assert.ok(served != null, type);
        const { status, body } = await get(harness.federation, saved.iri);
        assert.equal(status, 200, type);
        assert.deepEqual(body, served, type);
        assert.equal(body.type, type);
        assert.deepEqual(blindKeys(body), [], type);
        assert.deepEqual(body["test:extension"], extensionValue, type);
        const other = saved.iri.replace(
          `/ap/${route}/`,
          route === "creates" ? "/ap/activities/" : "/ap/creates/",
        );
        assert.equal((await get(harness.federation, other)).status, 404, type);
        // The parsing outgoing payloads use reads every type as itself.
        const vocab = await parseVocab(ctx, served);
        assert.equal(getTypeId(vocab).href, `${AS}#${type}`);
        assert.deepEqual(await vocab.toJsonLd(ctx), served, type);
        iris.push(saved.iri);
      }
      // Both routes share one outbox, newest first, across its pages.
      const ids = (body: Record<string, unknown>) =>
        (body.orderedItems as Record<string, unknown>[]).map(({ id }) => id);
      const collection = await get(harness.federation, `${actorIri}/outbox`);
      assert.equal(collection.body.totalItems, activityTypes.length);
      const first = await get(harness.federation, `${actorIri}/outbox?cursor=`);
      assert.equal(typeof first.body.next, "string");
      const last = await get(harness.federation, String(first.body.next));
      assert.equal(last.body.next, undefined);
      assert.deepEqual(
        [...ids(first.body), ...ids(last.body)],
        iris.toReversed(),
      );
    });
  });

  it("serializes a saved activity the same way for other uses", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const saved = await save(env, fixtures[6]!.document, "activity");
      const snapshot = await loadActivitySnapshot(harness.db, saved.id);
      assert.equal(snapshot?.revisionId, saved.revisionId);
      assert.deepEqual(snapshot?.document, saved.document);
      const served = publicDocument(snapshot!.document)!;
      const ctx = harness.federation.createContext(
        new URL(`https://${host}/`),
        undefined,
      );
      const vocab = await parseVocab(ctx, served);
      assert.ok(vocab instanceof Like);
      assert.deepEqual(await vocab.toJsonLd(ctx), served);
      const note = await save(
        env,
        { "@context": AS, type: "Note", content: "x" },
        "object",
      );
      assert.equal(await loadActivitySnapshot(harness.db, note.id), null);
    });
  });

  for (const scenario of [
    "unpublished",
    "followers",
    "wrongHost",
    "otherInstance",
    "deletedActor",
    "malformed",
  ] as const) {
    it(`does not serve ${scenario} saved activities`, async () => {
      await withFederation(async (harness) => {
        const env = await setUp(harness);
        const saved = await save(
          env,
          {
            "@context": AS,
            type: "Like",
            object: "https://remote.example/notes/1",
            to: [
              scenario === "followers" ? `${actorIri}/followers` : PUBLIC_IRI,
            ],
          },
          "activity",
          { publish: scenario !== "unpublished" },
        );
        const iri =
          scenario === "malformed"
            ? `https://${host}/ap/activities/bad`
            : scenario === "unpublished" || scenario === "followers"
              ? saved.iri
              : (await misdirect(harness, scenario))(saved.iri);
        assert.equal((await get(harness.federation, iri)).status, 404);
      });
    });
  }
});

describe("federation reads of saved objects and their history", () => {
  it("serves a saved object as saved, and only a Public one", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const note = {
        "@context": AS,
        type: "Note",
        content: "x",
        to: [PUBLIC_IRI],
        bcc: [blind],
      };
      const saved = await save(env, note, "object");
      const { status, body } = await get(harness.federation, saved.iri);
      assert.equal(status, 200);
      assert.deepEqual(body, publicDocument(saved.document));
      assert.equal(body.bcc, undefined);
      // Only the actor the object is attributed to serves it.
      const elsewhere = saved.iri.replace(localActorId, uuidV7());
      assert.equal((await get(harness.federation, elsewhere)).status, 404);
      const followers = await save(
        env,
        { ...note, to: [`${actorIri}/followers`] },
        "object",
      );
      assert.equal((await get(harness.federation, followers.iri)).status, 404);
    });
  });

  it("serves a saved object and its Tombstone at its author's route only", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const otherId = "00000000-0000-4000-8000-000000000203" as Uuid;
      await harness.db
        .insert(schema.localActors)
        .values({ id: otherId, avatar: "avatar.png", header: "header.png" });
      await seedActors(
        harness.db,
        {
          id: otherId,
          localId: otherId,
          instanceId: localInstanceId,
          type: "Person",
          username: "bob",
          iri: `https://${host}/users/${otherId}`,
          inboxUrl: `https://${host}/users/${otherId}/inbox`,
          created,
        },
        { keys: false },
      );
      const note = { "@context": AS, type: "Note", to: [PUBLIC_IRI] };
      const kept = await save(env, { ...note, content: "x" }, "object");
      const deleted = await save(env, { ...note, content: "y" }, "object");
      await remove(env, deleted.id);
      for (const [saved, status] of [
        [kept, 200],
        [deleted, 410],
      ] as const) {
        assert.equal((await get(harness.federation, saved.iri)).status, status);
        // Another live actor of the same instance does not serve it.
        const elsewhere = saved.iri.replace(localActorId, otherId);
        assert.equal((await get(harness.federation, elsewhere)).status, 404);
      }
    });
  });

  for (const scenario of [
    "wrongHost",
    "otherInstance",
    "deletedActor",
  ] as const) {
    it(`does not serve saved objects or their Tombstones for ${scenario}`, async () => {
      await withFederation(async (harness) => {
        const env = await setUp(harness);
        const note = { "@context": AS, type: "Note", to: [PUBLIC_IRI] };
        const kept = await save(env, { ...note, content: "x" }, "object");
        const deleted = await save(env, { ...note, content: "y" }, "object");
        await remove(env, deleted.id);
        assert.equal((await get(harness.federation, kept.iri)).status, 200);
        assert.equal((await get(harness.federation, deleted.iri)).status, 410);
        const iri = await misdirect(harness, scenario);
        for (const saved of [kept, deleted]) {
          const { status } = await get(harness.federation, iri(saved.iri));
          assert.equal(status, 404);
        }
      });
    });
  }

  it("keeps past activities as they were saved when the object changes", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const embedded = await save(
        env,
        {
          "@context": AS,
          type: "Create",
          to: [PUBLIC_IRI],
          object: {
            type: "Note",
            content: "A",
            to: [PUBLIC_IRI],
            bcc: [blind],
          },
        },
        "activity",
        { nested: [{ path: ["object"], kind: "object" }] },
      );
      const noteIri = (embedded.document.object as { id: string }).id;
      const noteId = noteIri.slice(noteIri.lastIndexOf("/") + 1) as Uuid;
      const referred = await save(
        env,
        { "@context": AS, type: "Like", to: [PUBLIC_IRI], object: noteIri },
        "activity",
      );
      const update = await edit(env, noteId, (document) => ({
        ...document,
        content: "B",
      }));
      const before = await get(harness.federation, embedded.iri);
      assert.equal(before.status, 200);
      assert.equal((before.body.object as { content: string }).content, "A");
      assert.equal(
        (await get(harness.federation, referred.iri)).body.object,
        noteIri,
      );
      const served = await get(harness.federation, update.iri);
      assert.equal(served.status, 200);
      assert.equal(served.body.type, "Update");
      assert.equal((served.body.object as { content: string }).content, "B");
      assert.deepEqual(blindKeys(update.document), ["bcc", "bcc"]);
      assert.deepEqual(blindKeys(served.body), []);
      assert.equal(
        ((await get(harness.federation, noteIri)).body as { content: string })
          .content,
        "B",
      );
    });
  });

  it("serves a deleted object as a Tombstone and only the Delete about it", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const create = await save(
        env,
        {
          "@context": AS,
          type: "Create",
          to: [PUBLIC_IRI],
          object: {
            type: "Note",
            content: "A",
            to: [PUBLIC_IRI],
            bcc: [blind],
          },
        },
        "activity",
        { nested: [{ path: ["object"], kind: "object" }] },
      );
      const noteIri = (create.document.object as { id: string }).id;
      const noteId = noteIri.slice(noteIri.lastIndexOf("/") + 1) as Uuid;
      const like = await save(
        env,
        { "@context": AS, type: "Like", to: [PUBLIC_IRI], object: noteIri },
        "activity",
      );
      const update = await edit(env, noteId, (document) => ({
        ...document,
        content: "B",
      }));
      const deletion = await remove(env, noteId);
      const tombstone = await get(harness.federation, noteIri);
      assert.equal(tombstone.status, 410);
      const { "@context": _, ...rest } = tombstone.body;
      assert.deepEqual(Object.keys(rest).toSorted(), ["deleted", "id", "type"]);
      assert.equal(rest.type, "Tombstone");
      assert.equal(rest.id, noteIri);
      const whiteout = await head(harness.db, noteId);
      assert.equal(
        Temporal.Instant.from(String(rest.deleted)).epochNanoseconds,
        whiteout.deleted?.epochNanoseconds,
      );
      for (const hidden of [create, like, update]) {
        assert.equal((await get(harness.federation, hidden.iri)).status, 404);
      }
      const served = await get(harness.federation, deletion.iri);
      assert.equal(served.status, 200);
      assert.equal(served.body.type, "Delete");
      assert.equal(served.body.object, noteIri);
      assert.deepEqual(blindKeys(served.body), []);
      // A followers-only object stays hidden after its deletion as well.
      const followers = await save(
        env,
        {
          "@context": AS,
          type: "Note",
          content: "x",
          to: [`${actorIri}/followers`],
        },
        "object",
      );
      await remove(env, followers.id);
      assert.equal((await get(harness.federation, followers.iri)).status, 404);
    });
  });

  it("serves the Update and Delete of a legacy object beside its typed rows", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const legacy = await createLegacyObject(env, principal, {
        actorId: localActorId,
        type: "Note",
        contentHtml: "<p>A</p>",
        name: null,
        summary: null,
        language: null,
        sensitive: false,
        addressing: { to: [PUBLIC_IRI], bcc: [blind] },
      });
      assert.ok(!isLocalWriteError(legacy));
      const legacyIri = `${actorIri}/${legacy.id}`;
      const createIri = `https://${host}/ap/creates/${legacy.activityId}`;
      const original = await get(harness.federation, createIri);
      assert.equal(original.status, 200);
      const update = await edit(env, legacy.id, (document) => ({
        ...document,
        content: "<p>B</p>",
        cc: [bob],
      }));
      const object = await get(harness.federation, legacyIri);
      assert.equal(object.body.content, "<p>B</p>");
      assert.equal(object.body.cc, bob);
      // Neither the object's content nor its recipients rewrite the Create.
      const legacyCreate = await get(harness.federation, createIri);
      assert.deepEqual(legacyCreate, original);
      // A legacy Create is served at its own route only.
      assert.equal(
        (
          await get(
            harness.federation,
            createIri.replace("/ap/creates/", "/ap/activities/"),
          )
        ).status,
        404,
      );
      assert.equal(legacyCreate.body.object, legacyIri);
      const served = await get(harness.federation, update.iri);
      assert.equal(served.status, 200);
      assert.deepEqual(blindKeys(served.body), []);
      const deletion = await remove(env, legacy.id);
      assert.equal((await get(harness.federation, legacyIri)).status, 410);
      assert.equal((await get(harness.federation, createIri)).status, 404);
      assert.equal((await get(harness.federation, update.iri)).status, 404);
      const deleted = await get(harness.federation, deletion.iri);
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.object, legacyIri);
      assert.deepEqual(blindKeys(deleted.body), []);
    });
  });
});

describe("embedded documents and implicit contexts", () => {
  const outboxIds = async (federation: Federation<unknown>) => {
    const collection = await get(federation, `${actorIri}/outbox`);
    const page = await get(federation, `${actorIri}/outbox?cursor=`);
    const items = (page.body.orderedItems ?? []) as Record<string, unknown>[];
    assert.equal(collection.body.totalItems, items.length);
    return items.map(({ id }) => id);
  };

  it("does not serve a Public activity that embeds content addressed to others", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const restricted = await save(
        env,
        {
          "@context": AS,
          type: "Create",
          to: [PUBLIC_IRI],
          object: { type: "Note", content: "secret", to: [bob] },
        },
        "activity",
        { nested: [{ path: ["object"], kind: "object" }] },
      );
      const noteIri = (restricted.document.object as { id: string }).id;
      assert.equal((await get(harness.federation, noteIri)).status, 404);
      assert.equal((await get(harness.federation, restricted.iri)).status, 404);
      const deep = await save(
        env,
        {
          "@context": AS,
          type: "Undo",
          to: [PUBLIC_IRI],
          object: {
            type: "Like",
            object: { type: "Note", content: "secret", cc: [bob] },
          },
        },
        "activity",
        {
          nested: [
            { path: ["object"], kind: "activity" },
            { path: ["object", "object"], kind: "object" },
          ],
        },
      );
      assert.equal((await get(harness.federation, deep.iri)).status, 404);
      // A document without recipients of its own goes with the activity.
      const open = await save(
        env,
        {
          "@context": AS,
          type: "Create",
          to: [PUBLIC_IRI],
          object: { type: "Note", content: "open" },
        },
        "activity",
        { nested: [{ path: ["object"], kind: "object" }] },
      );
      assert.equal((await get(harness.federation, open.iri)).status, 200);
      assert.deepEqual(await outboxIds(harness.federation), [open.iri]);
    });
  });

  it("reads embedded recipients as the addressing index does", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const served: string[] = [];
      for (const [to, status] of [
        [[{ type: "Collection", id: PUBLIC_IRI }], 200],
        [{ type: "Collection", id: "as:Public" }, 200],
        [[{ type: "Link", href: PUBLIC_IRI }], 200],
        [[{ type: "Collection", id: `${actorIri}/followers` }], 404],
      ] as const) {
        const create = await save(
          env,
          {
            "@context": AS,
            type: "Create",
            to: [PUBLIC_IRI],
            object: { type: "Note", content: "x", to },
          },
          "activity",
          { nested: [{ path: ["object"], kind: "object" }] },
        );
        const noteIri = (create.document.object as { id: string }).id;
        assert.equal((await get(harness.federation, noteIri)).status, status);
        assert.equal(
          (await get(harness.federation, create.iri)).status,
          status,
        );
        if (status === 200) served.unshift(create.iri);
      }
      // The Note's own collection is not a recipient of the Like around it.
      const undo = await save(
        env,
        {
          "@context": AS,
          type: "Undo",
          to: [PUBLIC_IRI],
          object: {
            type: "Like",
            object: {
              type: "Note",
              content: "x",
              to: PUBLIC_IRI,
              cc: { type: "Collection", id: `${actorIri}/followers` },
            },
          },
        },
        "activity",
        {
          nested: [
            { path: ["object"], kind: "activity" },
            { path: ["object", "object"], kind: "object" },
          ],
        },
      );
      assert.equal((await get(harness.federation, undo.iri)).status, 200);
      assert.deepEqual(await outboxIds(harness.federation), [
        undo.iri,
        ...served,
      ]);
    });
  });

  it("serves values Fedify does not parse, such as Link recipients and objects", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const note = await save(
        env,
        { "@context": AS, type: "Note", content: "x", to: [PUBLIC_IRI] },
        "object",
      );
      const audience = await save(
        env,
        {
          "@context": AS,
          type: "Like",
          to: [PUBLIC_IRI],
          audience: { type: "Link", href: bob },
          object: "https://remote.example/notes/1",
        },
        "activity",
      );
      const linked = await save(
        env,
        {
          "@context": AS,
          type: "Like",
          to: [PUBLIC_IRI],
          object: { type: "Link", href: note.iri },
        },
        "activity",
      );
      // A functional property may be a singleton list.
      const listed = await save(
        env,
        {
          "@context": AS,
          type: "Like",
          to: [PUBLIC_IRI],
          object: { type: "Link", href: [note.iri] },
        },
        "activity",
      );
      for (const saved of [audience, linked, listed]) {
        const { status, body } = await get(harness.federation, saved.iri);
        assert.equal(status, 200);
        assert.deepEqual(body, publicDocument(saved.document));
      }
      const page = await get(harness.federation, `${actorIri}/outbox?cursor=`);
      assert.deepEqual(page.body.orderedItems, [
        publicDocument(listed.document),
        publicDocument(linked.document),
        publicDocument(audience.document),
      ]);
      // A Link names the object it refers to, as a reference does.
      const deletion = await remove(env, note.id);
      assert.equal((await get(harness.federation, linked.iri)).status, 404);
      assert.equal((await get(harness.federation, listed.iri)).status, 404);
      assert.deepEqual(await outboxIds(harness.federation), [
        deletion.iri,
        audience.iri,
      ]);
    });
  });

  it("reads a Public Link recipient whose href is a list of one value", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const served: string[] = [];
      // Null stands for no value, so either list has one.
      for (const href of [[PUBLIC_IRI], [null, PUBLIC_IRI]]) {
        const like = await save(
          env,
          {
            "@context": AS,
            type: "Like",
            to: { type: "Link", href },
            object: "https://remote.example/notes/1",
          },
          "activity",
        );
        const { status, body } = await get(harness.federation, like.iri);
        assert.equal(status, 200);
        assert.deepEqual(body, publicDocument(like.document));
        served.unshift(like.iri);
      }
      assert.deepEqual(await outboxIds(harness.federation), served);
    });
  });

  it("reads documents that share an id as JSON-LD joins them", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const note = await save(
        env,
        { "@context": AS, type: "Note", content: "x", to: [PUBLIC_IRI] },
        "object",
      );
      const link = "https://remote.example/links/1";
      // Two embedded documents with one id are one, which neither tells.
      const shared = await save(
        env,
        {
          "@context": AS,
          type: "Add",
          to: [PUBLIC_IRI],
          object: { type: "Link", id: link, href: "https://remote.example/n" },
          target: { type: "Link", id: link, href: note.iri },
        },
        "activity",
      );
      assert.equal((await get(harness.federation, shared.iri)).status, 404);
      // A reference names what a Link embedded elsewhere with its id does.
      const referred = await save(
        env,
        {
          "@context": AS,
          type: "Add",
          to: [PUBLIC_IRI],
          object: link,
          target: { type: "Link", id: link, href: note.iri },
        },
        "activity",
      );
      assert.equal((await get(harness.federation, referred.iri)).status, 200);
      const deletion = await remove(env, note.id);
      assert.equal((await get(harness.federation, referred.iri)).status, 404);
      assert.deepEqual(await outboxIds(harness.federation), [deletion.iri]);
    });
  });

  it("reads a node object in an extension value whose own href is its id", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const self = "https://remote.example/x";
      const saved = await save(
        env,
        {
          "@context": [AS, { ex: "https://ext.example/ns#" }],
          type: "Like",
          to: [PUBLIC_IRI],
          object: "https://remote.example/notes/1",
          "ex:quoted": { type: "Link", id: self, href: self },
        },
        "activity",
      );
      const { status, body } = await get(harness.federation, saved.iri);
      assert.equal(status, 200);
      assert.deepEqual(body, publicDocument(saved.document));
      assert.deepEqual(await outboxIds(harness.federation), [saved.iri]);
    });
  });

  it("hides an activity that embeds a deleted object at any depth", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const undo = await save(
        env,
        {
          "@context": AS,
          type: "Undo",
          to: [PUBLIC_IRI],
          object: {
            type: "Like",
            object: { type: "Note", content: "gone", to: [PUBLIC_IRI] },
          },
        },
        "activity",
        {
          nested: [
            { path: ["object"], kind: "activity" },
            { path: ["object", "object"], kind: "object" },
          ],
        },
      );
      const noteIri = (undo.document.object as { object: { id: string } })
        .object.id;
      assert.equal((await get(harness.federation, undo.iri)).status, 200);
      const deletion = await remove(
        env,
        noteIri.slice(noteIri.lastIndexOf("/") + 1) as Uuid,
      );
      assert.equal((await get(harness.federation, undo.iri)).status, 404);
      assert.deepEqual(await outboxIds(harness.federation), [deletion.iri]);
    });
  });

  it("hides an activity embedding another about a deleted object, unless a Delete", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const note = await save(
        env,
        { "@context": AS, type: "Note", content: "x", to: [PUBLIC_IRI] },
        "object",
      );
      const undo = await save(
        env,
        {
          "@context": AS,
          type: "Undo",
          to: [PUBLIC_IRI],
          object: { type: "Like", object: note.iri },
        },
        "activity",
        { nested: [{ path: ["object"], kind: "activity" }] },
      );
      const announce = await save(
        env,
        {
          "@context": AS,
          type: "Announce",
          to: [PUBLIC_IRI],
          object: {
            id: "https://remote.example/deletes/1",
            type: "Delete",
            actor: bob,
            object: note.iri,
          },
        },
        "activity",
      );
      for (const saved of [undo, announce]) {
        assert.equal((await get(harness.federation, saved.iri)).status, 200);
      }
      const deletion = await remove(env, note.id);
      assert.equal((await get(harness.federation, undo.iri)).status, 404);
      assert.equal((await get(harness.federation, announce.iri)).status, 200);
      assert.deepEqual(await outboxIds(harness.federation), [
        deletion.iri,
        announce.iri,
      ]);
    });
  });

  it("applies the rules of embedded documents to node objects in extension values", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const like = (quoted: JsonObject | JsonObject[]): JsonObject => ({
        "@context": [
          AS,
          {
            ex: "https://ext.example/ns#",
            toMap: { "@id": "as:to", "@container": "@language" },
            labels: { "@id": "ex:labels", "@container": "@language" },
            _: `${AS}#`,
          },
        ],
        type: "Like",
        to: [PUBLIC_IRI],
        object: "https://remote.example/notes/1",
        "ex:quoted": quoted,
      });
      const open = await save(
        env,
        like({
          type: "Note",
          content: "open",
          to: [PUBLIC_IRI],
          bcc: [blind],
          attachment: {
            type: "Note",
            content: "deep",
            to: PUBLIC_IRI,
            bto: blind,
          },
        }),
        "activity",
      );
      const served = await get(harness.federation, open.iri);
      assert.equal(served.status, 200);
      assert.deepEqual(served.body, publicDocument(open.document));
      assert.deepEqual(blindKeys(open.document), ["bcc", "bto"]);
      assert.deepEqual(blindKeys(served.body), []);
      // A blank node identifier and a language map stay readable.
      const readable: string[] = [];
      for (const quoted of [
        { id: "_:b0", type: "Note", content: "open", to: [PUBLIC_IRI] },
        {
          type: "Note",
          content: "open",
          to: [PUBLIC_IRI],
          labels: { id: "Halo", bcc: "Hello" },
        },
      ]) {
        const saved = await save(env, like(quoted), "activity");
        const response = await get(harness.federation, saved.iri);
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, publicDocument(saved.document));
        readable.unshift(saved.iri);
      }
      const hidden: SavedResource[] = [];
      for (const quoted of [
        { type: "Note", content: "secret", to: [bob], bcc: [blind] },
        {
          type: "Note",
          content: "secret",
          to: { id: `${actorIri}/followers` },
        },
        { type: "Note", content: "secret", to: { "@set": [bob] } },
        { type: "Note", content: "secret", to: { "@set": [{ id: bob }] } },
        { type: "Note", content: "secret", to: { "@value": PUBLIC_IRI } },
        {
          type: "Note",
          content: "secret",
          to: { type: "Link", id: PUBLIC_IRI, href: bob },
        },
        // A literal is no recipient, nor is a value read with another context.
        { type: "Note", content: "secret", to: bob, [`${AS}#to`]: PUBLIC_IRI },
        {
          type: "Note",
          content: "secret",
          to: {
            "@context": { as: "https://a.example/" },
            "@set": ["as:Public"],
          },
        },
        // A key with a @language container holds node objects in a list.
        {
          type: "Note",
          content: "x",
          to: [PUBLIC_IRI],
          labels: [{ type: "Note", content: "secret", to: [bob] }],
        },
        // An object in a language map is no valid JSON-LD.
        {
          type: "Note",
          content: "x",
          to: [PUBLIC_IRI],
          labels: { en: { bcc: [blind] } },
        },
        // A node object whose id is used elsewhere is not read apart.
        { id: "https://remote.example/notes/1", type: "Note", to: [bob] },
        // A blank node is no compact IRI, whatever prefix "_" names.
        { type: "Note", content: "secret", to: [bob, "_:Public"] },
        // Only a Link names a recipient by its href.
        {
          type: "Note",
          content: "secret",
          to: [bob],
          cc: { type: "Note", href: PUBLIC_IRI },
        },
        // A value is a scalar or a JSON literal, and reverse properties are
        // not read.
        { "@value": { type: "Note", to: [bob], bcc: [blind], content: "x" } },
        {
          id: bob,
          "@reverse": { attributedTo: { type: "Note", content: "x" } },
        },
        // A value with keys a context of its own may alias is not read,
        // nor is a list with properties, which is no valid JSON-LD.
        {
          "@context": { kind: "@type" },
          kind: "@json",
          "@value": { bcc: "data" },
        },
        {
          type: "Note",
          content: "x",
          to: [PUBLIC_IRI],
          cc: { "@set": [], bcc: blind },
        },
        // Properties nested with @nest are not read.
        {
          type: "Note",
          content: "secret",
          to: [PUBLIC_IRI],
          "@nest": { cc: [bob] },
        },
        // A relative reference names no resource that can be checked.
        { type: "Note", id: "/notes/1", content: "secret" },
        // A language map holds no recipients, and a Link has one href.
        { type: "Note", content: "secret", to: bob, toMap: { id: PUBLIC_IRI } },
        {
          type: "Like",
          object: {
            type: "Link",
            href: ["https://remote.example/notes/1", `${actorIri}/notes/1`],
          },
        },
        { "@context": { secret: "as:bcc" }, content: "x", secret: [blind] },
      ]) {
        hidden.push(await save(env, like(quoted), "activity"));
      }
      for (const saved of hidden) {
        assert.equal((await get(harness.federation, saved.iri)).status, 404);
      }
      // A deleted object found in the second lookup hides the activity too.
      const note = await save(
        env,
        { "@context": AS, type: "Note", content: "x", to: [PUBLIC_IRI] },
        "object",
      );
      const quoting = await save(
        env,
        like([
          ...Array.from({ length: 1000 }, (_, index) => ({
            id: `https://remote.example/quoted/${index}`,
          })),
          { id: note.iri, type: "Note", content: "x" },
        ]),
        "activity",
      );
      // So does an activity about it, unless that is its Delete.
      const liking = await save(
        env,
        like({ type: "Like", actor: bob, object: note.iri }),
        "activity",
      );
      const deleting = await save(
        env,
        like({ type: "Delete", actor: actorIri, object: note.iri }),
        "activity",
      );
      const blankDeleting = await save(
        env,
        like({ type: "_:Delete", actor: actorIri, object: note.iri }),
        "activity",
      );
      const linking = await save(
        env,
        like({
          type: "Like",
          actor: bob,
          object: {
            type: "Link",
            id: "https://remote.example/links/1",
            href: note.iri,
          },
        }),
        "activity",
      );
      for (const saved of [quoting, liking, deleting, blankDeleting, linking]) {
        assert.equal((await get(harness.federation, saved.iri)).status, 200);
      }
      const deletion = await remove(env, note.id);
      assert.equal((await get(harness.federation, quoting.iri)).status, 404);
      assert.equal((await get(harness.federation, liking.iri)).status, 404);
      assert.equal((await get(harness.federation, linking.iri)).status, 404);
      assert.equal(
        (await get(harness.federation, blankDeleting.iri)).status,
        404,
      );
      assert.equal((await get(harness.federation, deleting.iri)).status, 200);
      assert.deepEqual(await outboxIds(harness.federation), [
        deletion.iri,
        deleting.iri,
        ...readable,
        open.iri,
      ]);
    });
  });

  it("serves a document saved without a context with the ActivityStreams one", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const like = await save(
        env,
        {
          type: "Like",
          to: [PUBLIC_IRI],
          bcc: [blind],
          object: "https://remote.example/notes/1",
        },
        "activity",
      );
      assert.equal(like.document["@context"], undefined);
      const { bcc: _, ...rest } = like.document;
      const expected = { "@context": AS, ...rest };
      assert.deepEqual(publicDocument(like.document), expected);
      const served = await get(harness.federation, like.iri);
      assert.equal(served.status, 200);
      assert.deepEqual(served.body, expected);
      assert.deepEqual(await outboxIds(harness.federation), [like.iri]);
      const note = await save(
        env,
        { type: "Note", content: "x", to: [PUBLIC_IRI] },
        "object",
      );
      const object = await get(harness.federation, note.iri);
      assert.equal(object.status, 200);
      assert.equal(object.body["@context"], AS);
    });
  });
});

describe("outboxes of saved and legacy activities", () => {
  it("pages and counts both in one order, leaving out what is not served", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const legacy = await createLegacyObject(env, principal, {
        actorId: localActorId,
        type: "Note",
        contentHtml: "<p>A</p>",
        name: null,
        summary: null,
        language: null,
        sensitive: false,
        addressing: { to: [PUBLIC_IRI] },
      });
      assert.ok(!isLocalWriteError(legacy));
      const like = await save(
        env,
        {
          "@context": AS,
          type: "Like",
          to: [PUBLIC_IRI],
          bcc: [blind],
          object: "https://remote.example/notes/1",
        },
        "activity",
      );
      await save(
        env,
        { "@context": AS, type: "Like", to: [PUBLIC_IRI], object: like.iri },
        "activity",
        { publish: false },
      );
      await save(
        env,
        {
          "@context": AS,
          type: "Like",
          to: [`${actorIri}/followers`],
          object: "https://remote.example/notes/2",
        },
        "activity",
      );
      const create = await save(
        env,
        {
          "@context": AS,
          type: "Create",
          to: [PUBLIC_IRI],
          object: { type: "Note", content: "x", to: [PUBLIC_IRI] },
        },
        "activity",
        { nested: [{ path: ["object"], kind: "object" }] },
      );
      const noteIri = (create.document.object as { id: string }).id;
      const deletion = await remove(
        env,
        noteIri.slice(noteIri.lastIndexOf("/") + 1) as Uuid,
      );
      const collection = await get(harness.federation, `${actorIri}/outbox`);
      const page = await get(harness.federation, `${actorIri}/outbox?cursor=`);
      assert.equal(page.status, 200);
      const items = page.body.orderedItems as Record<string, unknown>[];
      assert.deepEqual(
        items.map(({ id }) => id),
        [
          deletion.iri,
          like.iri,
          `https://${host}/ap/creates/${legacy.activityId}`,
        ],
      );
      assert.equal(collection.body.totalItems, items.length);
      assert.deepEqual(items[1], publicDocument(like.document));
      assert.deepEqual(blindKeys(items), []);
      assert.equal(page.body.next, undefined);
    });
  });

  // FIXME: https://github.com/fedify-dev/drfed/issues/178
  it(
    "pages an activity whose context redefines a protected term as JSON-LD",
    {
      expectFailure: (error: unknown) =>
        (error as { details?: { code?: unknown } } | null)?.details?.code ===
        "protected term redefinition",
    },
    async () => {
      await withFederation(async (harness) => {
        const env = await setUp(harness);
        const plain = await save(
          env,
          {
            "@context": AS,
            type: "Like",
            to: [PUBLIC_IRI],
            object: "https://remote.example/notes/1",
          },
          "activity",
        );
        const redefining = await save(
          env,
          {
            "@context": [AS, { proof: "https://example.org/proof" }],
            type: "Like",
            to: [PUBLIC_IRI],
            object: "https://remote.example/notes/2",
          },
          "activity",
        );
        assert.equal(
          (await get(harness.federation, redefining.iri)).status,
          200,
        );
        const page = await get(
          harness.federation,
          `${actorIri}/outbox?cursor=`,
        );
        assert.equal(page.status, 200);
        // A JSON-LD client reads the page, not only its JSON.
        const parsed = await OrderedCollectionPage.fromJsonLd(page.body);
        const ids: (string | undefined)[] = [];
        for await (const item of parsed.getItems()) ids.push(item.id?.href);
        assert.deepEqual(ids, [redefining.iri, plain.iri]);
      });
    },
  );

  it("leaves out an activity whose saved document cannot be served", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const like = await save(
        env,
        {
          "@context": AS,
          type: "Like",
          to: [PUBLIC_IRI],
          object: "https://remote.example/notes/1",
        },
        "activity",
      );
      // Documents the write path would refuse, stored as if edited by hand.
      const broken: string[] = [];
      for (const document of [
        {
          "@context": [AS, "https://gotosocial.org/ns"],
          type: "Like",
          object: "https://remote.example/notes/2",
        },
        {
          "@context": AS,
          id: "https://remote.example/activities/1",
          type: "Like",
          object: "https://remote.example/notes/3",
        },
      ]) {
        const id = uuidV7();
        const iri = `https://${host}/ap/activities/${id}`;
        await harness.db.transaction(async (tx) => {
          await ensureResource(tx, iri, id);
          await appendResourceRevision(tx, {
            resourceId: id,
            resourceKind: "activity",
            expectedRevisionId: null,
            kind: "snapshot",
            document: {
              id: iri,
              actor: actorIri,
              to: [PUBLIC_IRI],
              ...document,
            },
            capture: "local",
          });
          await storeAddressingOccurrences(tx, id, [
            { property: "to", position: 0, iri: PUBLIC_IRI },
          ]);
          await addActorCollectionItem(tx, localActorId, "outbox", id);
        });
        broken.push(iri);
      }
      for (const iri of broken) {
        assert.equal((await get(harness.federation, iri)).status, 404);
      }
      const collection = await get(harness.federation, `${actorIri}/outbox`);
      const page = await get(harness.federation, `${actorIri}/outbox?cursor=`);
      assert.equal(page.status, 200);
      assert.deepEqual(
        (page.body.orderedItems as Record<string, unknown>[]).map(
          ({ id }) => id,
        ),
        [like.iri],
      );
      assert.equal(collection.body.totalItems, 1);
    });
  });

  it("fills pages past activities their documents leave out", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const like = (object: JsonObject | string): JsonObject => ({
        "@context": AS,
        type: "Like",
        to: [PUBLIC_IRI],
        object,
      });
      const oldest = await save(
        env,
        like("https://remote.example/n"),
        "activity",
      );
      // More hidden activities than several batches and a counter batch
      // hold, between served ones.
      for (let index = 0; index < 120; index += 1) {
        await save(
          env,
          like({ type: "Note", content: "secret", to: [bob] }),
          "activity",
        );
      }
      const newest: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const saved = await save(
          env,
          like(`https://remote.example/notes/${index}`),
          "activity",
        );
        newest.unshift(saved.iri);
      }
      const ids = (body: Record<string, unknown>) =>
        (body.orderedItems as Record<string, unknown>[]).map(({ id }) => id);
      const first = await get(harness.federation, `${actorIri}/outbox?cursor=`);
      assert.deepEqual(ids(first.body), newest);
      assert.equal(typeof first.body.next, "string");
      const last = await get(harness.federation, String(first.body.next));
      assert.deepEqual(ids(last.body), [oldest.iri]);
      assert.equal(last.body.next, undefined);
      const collection = await get(harness.federation, `${actorIri}/outbox`);
      assert.equal(collection.body.totalItems, 21);
    });
  });

  it("serves only the outbox items its pages can reach", async () => {
    await withFederation(async (harness) => {
      const env = await setUp(harness);
      const like = await save(
        env,
        {
          "@context": AS,
          type: "Like",
          to: [PUBLIC_IRI],
          object: "https://remote.example/notes/1",
        },
        "activity",
      );
      await harness.db
        .update(schema.collectionItems)
        .set({ position: null })
        .where(eq(schema.collectionItems.itemId, like.id));
      assert.equal((await get(harness.federation, like.iri)).status, 404);
      const collection = await get(harness.federation, `${actorIri}/outbox`);
      assert.equal(collection.body.totalItems, 0);
    });
  });
});
