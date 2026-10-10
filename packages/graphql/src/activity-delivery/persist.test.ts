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

// oxlint-disable no-await-in-loop max-lines

import assert from "node:assert/strict";
import { it } from "node:test";

import { type Database, promoteResource, schema } from "@drfed/models";
import { InProcessMessageQueue, type MessageQueue } from "@fedify/fedify";

import { type TestHarness, withTestHarness } from "../harness.test.ts";
import {
  globalId,
  localActorId,
  localInstanceId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedLocalInstance,
  seedObjects,
} from "../seed.test.ts";
import {
  type Documents,
  PUBLIC,
  addActor,
  createOf,
  createRecorder,
  eventually,
  findDeliveries,
  hostA,
  hostB,
  hostC,
  post,
  seedOtherInstance,
  signed,
  thirdInstanceId,
  withWorkers,
} from "./inbox-fixture.test.ts";

const alice = "https://remote.example/users/alice";

const counts = async (db: Database) => ({
  instances: await db.$count(schema.instances),
  actors: await db.$count(schema.actors),
  objects: await db.$count(schema.objects),
  activities: await db.$count(schema.activities),
  addressing: await db.$count(schema.addressing),
});

const findActivity = (db: Database, iri: string) =>
  db.query.activities.findFirst({
    where: { resource: { iri } },
    with: { resource: true },
  });

/** Assert the rows a signed `Create(Note)` from alice is stored as. */
async function assertStored(db: Database): Promise<void> {
  const actor = await db.query.actors.findFirst({
    with: { instance: true, resource: true },
  });
  assert.equal(actor?.resource.iri, alice);
  assert.equal(actor?.instance.host, "remote.example");
  assert.equal(actor?.instance.localId, null);
  assert.equal(actor?.localId, null);
  assert.equal(actor?.username, "alice");
  assert.equal(actor?.inboxUrl, `${alice}/inbox`);
  assert.equal((actor?.document as { id?: unknown } | undefined)?.id, alice);
  const object = await db.query.objects.findFirst({
    with: { resource: true },
  });
  assert.equal(object?.resource.iri, "https://remote.example/notes/1");
  assert.equal(object?.actorId, actor?.id);
  assert.equal(object?.type, "Note");
  assert.equal(object?.contentHtml, "<p>1</p>");
  assert.equal(object?.published.toString(), "2026-10-01T00:00:00Z");
  const activity = await db.query.activities.findFirst({
    with: { addressing: { with: { targetResource: true } } },
  });
  assert.equal(activity?.objectId, object?.id);
  assert.equal(activity?.actorId, actor?.id);
  assert.deepEqual(
    activity?.addressing
      .map(({ property, targetResource }) => [property, targetResource.iri])
      .toSorted(),
    [
      ["cc", `${alice}/followers`],
      ["to", PUBLIC],
    ],
  );
}

/**
 * Assert that each delivery names the activity, and the activity each
 * delivery.
 */
async function assertLinkedBothWays(
  graphql: TestHarness["post"],
  init: RequestInit,
): Promise<void> {
  const response = await graphql(
    {
      query: `
        query ($id: ID!) {
          node(id: $id) {
            ... on Instance {
              activityDeliveries(first: 10) {
                edges {
                  node {
                    uuid
                    activity {
                      iri
                      deliveries(first: 10) { edges { node { uuid } } }
                    }
                  }
                }
              }
            }
          }
        }
      `,
      variables: { id: globalId("Instance", localInstanceId) },
    },
    init,
  );
  const { data, errors } = (await response.json()) as {
    data?: {
      node: {
        activityDeliveries: {
          edges: {
            node: {
              uuid: string;
              activity: {
                iri: string;
                deliveries: { edges: { node: { uuid: string } }[] };
              };
            };
          }[];
        };
      };
    };
    errors?: unknown;
  };
  assert.equal(errors, undefined);
  const edges = data?.node.activityDeliveries.edges ?? [];
  assert.equal(edges.length, 2);
  for (const { node } of edges) {
    assert.equal(node.activity.iri, "https://remote.example/activities/1");
    assert.deepEqual(
      node.activity.deliveries.edges.map((edge) => edge.node.uuid),
      edges.map((edge) => edge.node.uuid),
    );
  }
}

it("stores a signed Create once, and links every delivery of it", async () => {
  for (const queued of [false, true]) {
    await withTestHarness(async ({ db, post: graphql }) => {
      const init = await seedAuthenticatedLocalInstance(db);
      const documents: Documents = new Map();
      const signer = await addActor(documents, alice, {
        preferredUsername: "alice",
      });
      const { federation, send } = await createRecorder(
        db,
        documents,
        queued ? { queue: new InProcessMessageQueue() } : {},
      );
      const body = createOf(alice, "1");
      const settled = (count: number) =>
        eventually(
          () => findDeliveries(db),
          (rows) =>
            rows.length === count &&
            rows.every(
              (row) => row.activityId != null && row.status !== "acknowledged",
            ),
        );
      await withWorkers(federation, async () => {
        assert.equal((await send(await signed(signer, body))).status, 202);
        await settled(1);
        const before = await counts(db);
        assert.deepEqual(before, {
          instances: 2,
          actors: 1,
          objects: 1,
          activities: 1,
          addressing: 4,
        });
        // Fedify skips the listener of a duplicate, which is linked anyway.
        assert.equal((await send(await signed(signer, body))).status, 202);
        const deliveries = await eventually(
          () => findDeliveries(db),
          (rows) => rows.length === 2 && rows[1]?.activityId != null,
        );
        assert.deepEqual(await counts(db), before);
        const activity = await findActivity(
          db,
          "https://remote.example/activities/1",
        );
        assert.deepEqual(
          deliveries.map((row) => [row.status, row.activityId]),
          [
            ["received", activity?.id],
            ["acknowledged", activity?.id],
          ],
          `queued: ${queued}`,
        );
      });
      await assertStored(db);
      await assertLinkedBothWays(graphql, init);
    });
  }
});

it("never lets an unverified request claiming a stored IRI change it", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const { send } = await createRecorder(db, documents);
    const body = createOf(alice, "1");
    assert.equal((await send(await signed(signer, body))).status, 202);
    const stored = await findActivity(
      db,
      "https://remote.example/activities/1",
    );
    const before = await counts(db);
    const forged = createOf(alice, "1", {
      object: { content: "<p>forged</p>" },
    });
    assert.equal((await send(post(forged))).status, 401);
    const [, delivery] = await findDeliveries(db);
    assert.equal(delivery?.status, "unverified");
    assert.equal(delivery?.activityIri, "https://remote.example/activities/1");
    assert.equal(delivery?.activityId, null);
    assert.deepEqual(await counts(db), before);
    assert.deepEqual(
      (await findActivity(db, "https://remote.example/activities/1"))?.document,
      stored?.document,
    );
    assert.equal((await db.query.objects.findFirst())?.contentHtml, "<p>1</p>");
  });
});

it("stores nothing for a Create without an ID, however often it arrives", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const { send } = await createRecorder(db, documents);
    const body = createOf(alice, "1", { activity: { id: undefined } });
    for (const _ of [1, 2]) {
      assert.equal((await send(await signed(signer, body))).status, 202);
    }
    const deliveries = await findDeliveries(db);
    assert.deepEqual(
      deliveries.map((row) => [row.status, row.activityIri, row.activityId]),
      [
        ["received", null, null],
        ["received", null, null],
      ],
    );
    assert.equal(await db.$count(schema.activities), 0);
    assert.equal(await db.$count(schema.objects), 0);
  });
});

it(
  "rejects a verified Create claiming an IRI on another origin",
  {
    todo:
      "Fedify 2.4.1 accepts an activity ID on another origin than its " +
      "actor; this passes once Fedify rejects one with 401.",
  },
  async () => {
    await withTestHarness(async ({ db }) => {
      await seedLocalActor(db);
      const localActivityId = "01990000-0000-7000-8000-000000000001";
      await seedObjects(db, {
        id: "01990000-0000-7000-8000-000000000002",
        iri: `https://${hostA}/users/${localActorId}/notes/1`,
        actorId: localActorId,
        type: "Note",
        contentHtml: "<p>local</p>",
        activityId: localActivityId,
      });
      const documents: Documents = new Map();
      const signer = await addActor(documents, alice);
      const mallory = await addActor(
        documents,
        "https://evil.example/users/mallory",
      );
      const { send } = await createRecorder(db, documents);
      assert.equal(
        (await send(await signed(signer, createOf(alice, "1")))).status,
        202,
      );
      const before = await counts(db);
      for (const id of [
        "https://remote.example/activities/1",
        `https://${hostA}/ap/creates/${localActivityId}`,
        "https://third.example/activities/1",
      ]) {
        const forged = createOf(mallory.iri, "1", { activity: { id } });
        assert.equal((await send(await signed(mallory, forged))).status, 401);
        const delivery = (await findDeliveries(db)).at(-1);
        assert.equal(delivery?.status, "rejected");
        assert.match(delivery?.error ?? "", /^activityOriginMismatch/u);
        assert.equal(delivery?.activityId, null);
      }
      assert.deepEqual(await counts(db), before);
    });
  },
);

it("stores an object only of its actor, of a supported type, from its origin", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const bob = "https://remote.example/users/bob";
    await addActor(documents, bob);
    const note = (id: string, attributedTo = alice) => ({
      "@context": "https://www.w3.org/ns/activitystreams",
      id,
      type: "Note",
      attributedTo,
      content: "<p>fetched</p>",
    });
    documents.set(
      "https://third.example/notes/1",
      note("https://third.example/notes/1"),
    );
    documents.set(
      "https://remote.example/notes/fetched",
      note("https://remote.example/notes/fetched"),
    );
    const { send } = await createRecorder(db, documents);
    for (const body of [
      createOf(alice, "bob", { object: { attributedTo: bob } }),
      createOf(alice, "video", { object: { type: "Video" } }),
      createOf(alice, "empty", { object: { content: " " } }),
      createOf(alice, "third", { object: "https://third.example/notes/1" }),
      createOf(alice, "missing", {
        object: "https://remote.example/notes/missing",
      }),
    ]) {
      assert.equal((await send(await signed(signer, body))).status, 202);
    }
    assert.equal(await db.$count(schema.activities), 0);
    assert.equal(await db.$count(schema.objects), 0);
    const body = createOf(alice, "fetched", {
      object: "https://remote.example/notes/fetched",
    });
    assert.equal((await send(await signed(signer, body))).status, 202);
    const deliveries = await findDeliveries(db);
    assert.ok(deliveries.every((row) => row.status === "received"));
    assert.deepEqual(
      deliveries.map((row) => row.activityId != null),
      [false, false, false, false, false, true],
    );
    const object = await db.query.objects.findFirst({
      with: { resource: true },
    });
    assert.equal(object?.resource.iri, "https://remote.example/notes/fetched");
    assert.equal(object?.contentHtml, "<p>fetched</p>");
    // Only the IRI was received; the document is what was fetched.
    const document = object?.document as Record<string, unknown> | undefined;
    assert.equal(document?.id, "https://remote.example/notes/fetched");
    assert.equal(document?.content, "<p>fetched</p>");
    assert.equal(
      (await db.query.activities.findFirst())?.published.toString(),
      object?.published.toString(),
    );
  });
});

it("links a delivery between local instances to the activity its sender stored", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalActor(db);
    await seedOtherInstance(db);
    const activityId = "01990000-0000-7000-8000-000000000001";
    await seedObjects(db, {
      id: "01990000-0000-7000-8000-000000000002",
      iri: `https://${hostA}/users/${localActorId}/notes/1`,
      actorId: localActorId,
      type: "Note",
      contentHtml: "<p>local</p>",
      activityId,
    });
    const documents: Documents = new Map();
    const actorIri = `https://${hostA}/users/${localActorId}`;
    const signer = await addActor(documents, actorIri);
    const { send } = await createRecorder(db, documents);
    const before = await counts(db);
    const body = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `https://${hostA}/ap/creates/${activityId}`,
      type: "Create",
      actor: actorIri,
      object: `https://${hostA}/users/${localActorId}/notes/1`,
    };
    assert.equal((await send(await signed(signer, body, hostB))).status, 202);
    const [delivery] = await findDeliveries(db);
    assert.equal(delivery?.status, "received");
    assert.equal(delivery?.activityId, activityId);
    assert.deepEqual(await counts(db), before);
  });
});

it("stores the activity and object as received, at their arrival", async () => {
  const strip = (queue: MessageQueue): MessageQueue => ({
    enqueue: async (message, options) => {
      const { drfedReceived: _, ...rest } = message as Record<string, unknown>;
      await queue.enqueue(rest, options);
    },
    listen: (handler, options) => queue.listen(handler, options),
  });
  for (const mode of ["sync", "queued", "unmarked"] as const) {
    await withTestHarness(async ({ db }) => {
      await seedLocalInstance(db);
      const documents: Documents = new Map();
      const signer = await addActor(documents, alice);
      const queue = new InProcessMessageQueue();
      const { federation, send } = await createRecorder(
        db,
        documents,
        mode === "sync"
          ? {}
          : { queue: mode === "queued" ? queue : strip(queue) },
      );
      // Members are kept as they are, whatever Fedify would serialize.
      const body = JSON.parse(
        JSON.stringify(
          createOf(alice, "1", {
            activity: { summary: "kept" },
            object: { published: undefined, tag: [] },
          }),
        ),
      ) as Record<string, unknown>;
      await withWorkers(federation, async () => {
        assert.equal((await send(await signed(signer, body))).status, 202);
        await eventually(
          () => findDeliveries(db),
          (rows) => rows[0]?.status === "received",
        );
      });
      const [delivery] = await findDeliveries(db);
      assert.equal(delivery?.status, "received", mode);
      if (mode === "unmarked") {
        // A message enqueued without its arrival is not stored.
        assert.equal(await db.$count(schema.activities), 0);
        return;
      }
      assert.notEqual(delivery?.activityId, null, mode);
      const activity = await db.query.activities.findFirst();
      const object = await db.query.objects.findFirst();
      assert.deepEqual(activity?.document, delivery?.payload);
      assert.deepEqual(activity?.document, body);
      assert.deepEqual(object?.document, body.object);
      assert.ok(
        delivery != null &&
          object?.published.equals(delivery.created) === true &&
          activity?.published.equals(delivery.created) === true,
        mode,
      );
    });
  }
});

it("stores remote actors as they describe themselves", async () => {
  await withTestHarness(async ({ db, post: graphql }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const actors = {
      anonymous: await addActor(
        documents,
        "https://remote.example/users/anonymous",
      ),
      user: await addActor(documents, alice, { preferredUsername: "alice" }),
      bot: await addActor(documents, "https://remote.example/bots/alice", {
        preferredUsername: "alice",
      }),
      at: await addActor(documents, "https://remote.example/users/at", {
        preferredUsername: "a@b",
      }),
      inboxless: await addActor(documents, "https://remote.example/users/x", {
        inbox: false,
      }),
    };
    const { send } = await createRecorder(db, documents);
    for (const [name, signer] of Object.entries(actors)) {
      const body = createOf(signer.iri, name);
      assert.equal((await send(await signed(signer, body))).status, 202);
    }
    const stored = await db.query.actors.findMany({
      with: { resource: true },
    });
    assert.deepEqual(
      new Map(stored.map((actor) => [actor.resource.iri, actor.username])),
      new Map([
        [actors.anonymous.iri, null],
        [actors.user.iri, "alice"],
        [actors.bot.iri, "alice"],
        [actors.at.iri, "a@b"],
      ]),
    );
    assert.equal(await db.$count(schema.activities), 4);
    const anonymous = stored.find(
      (actor) => actor.resource.iri === actors.anonymous.iri,
    );
    const at = stored.find((actor) => actor.resource.iri === actors.at.iri);
    const query = async (id: string) => {
      const response = await graphql({
        query: `
          query ($id: ID!) {
            node(id: $id) { ... on Actor { username handle } }
          }
        `,
        variables: { id: globalId("Actor", id) },
      });
      return ((await response.json()) as { data?: { node: unknown } }).data
        ?.node;
    };
    assert.deepEqual(await query(anonymous?.id ?? ""), {
      username: null,
      handle: null,
    });
    assert.deepEqual(await query(at?.id ?? ""), {
      username: "a@b",
      handle: "@a@b@remote.example",
    });
  });
});

it("stores a Create received again, or by several instances, once", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    await seedOtherInstance(db);
    await seedOtherInstance(db, {
      id: thirdInstanceId,
      slug: "third-instance",
      host: hostC,
    });
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const bob = await addActor(documents, "https://remote.example/users/bob");
    const { send } = await createRecorder(db, documents);
    const body = createOf(alice, "1");
    // Each inbox runs its listener, which reuses what the first one stored.
    for (const host of [hostA, hostB]) {
      assert.equal((await send(await signed(signer, body, host))).status, 202);
    }
    // The same activity naming another object this time writes nothing, the
    // object included.
    const renamed = createOf(alice, "1", {
      object: { id: "https://remote.example/notes/renamed" },
    });
    assert.equal(
      (await send(await signed(signer, renamed, hostC))).status,
      202,
    );
    assert.deepEqual(await counts(db), {
      instances: 4,
      actors: 1,
      objects: 1,
      activities: 1,
      addressing: 4,
    });
    assert.equal(
      (await send(await signed(signer, createOf(alice, "2")))).status,
      202,
    );
    assert.deepEqual(await counts(db), {
      instances: 4,
      actors: 1,
      objects: 2,
      activities: 2,
      addressing: 8,
    });
    // An object already stored as another actor's is not taken over.
    const takeover = createOf(bob.iri, "3", {
      object: { id: "https://remote.example/notes/1", attributedTo: bob.iri },
    });
    assert.equal((await send(await signed(bob, takeover))).status, 202);
    // Nor is an IRI stored as another kind of resource.
    await promoteResource(
      db,
      "https://remote.example/activities/4",
      "collection",
      async (tx, resource) => {
        await tx
          .insert(schema.collections)
          .values({ id: resource.id, type: "OrderedCollection" });
      },
    );
    assert.equal(
      (await send(await signed(signer, createOf(alice, "4")))).status,
      202,
    );
    assert.deepEqual(await counts(db), {
      instances: 4,
      actors: 1,
      objects: 2,
      activities: 2,
      addressing: 8,
    });
    const deliveries = await findDeliveries(db);
    assert.ok(deliveries.every((row) => row.status === "received"));
    assert.deepEqual(
      deliveries.map((row) => row.activityId != null),
      [true, true, true, true, false, false],
    );
  });
});

it("keeps an object as the activity that first carried it", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const { send } = await createRecorder(db, documents);
    const first = createOf(alice, "1");
    const second = createOf(alice, "2", {
      object: {
        id: "https://remote.example/notes/1",
        content: "<p>changed</p>",
      },
    });
    for (const body of [first, second]) {
      assert.equal((await send(await signed(signer, body))).status, 202);
    }
    const object = await db.query.objects.findFirst({
      where: { resource: { iri: "https://remote.example/notes/1" } },
    });
    const carrier = await findActivity(
      db,
      "https://remote.example/activities/1",
    );
    assert.equal(object?.contentHtml, "<p>1</p>");
    assert.deepEqual(object?.document, first.object);
    assert.equal(object?.activityId, carrier?.id);
    assert.equal(
      (await findActivity(db, "https://remote.example/activities/2"))?.objectId,
      object?.id,
    );
  });
});

it("keeps the object as received however the document expresses it", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const { send } = await createRecorder(db, documents);
    const as = "https://www.w3.org/ns/activitystreams";
    const shapes: Record<
      string,
      (
        activity: Record<string, unknown>,
        object: unknown,
      ) => Record<string, unknown>
    > = {
      // `about` sorts before `obj` but is not `object`; `obj` is.
      alias: (activity, object) => ({
        ...activity,
        "@context": [
          as,
          { obj: "as:object", about: "https://example.com/ns#about" },
        ],
        about: { id: "https://remote.example/notes/decoy", type: "Note" },
        obj: object,
      }),
      graph: ({ "@context": context, ...activity }, object) => ({
        "@context": context,
        "@graph": [{ ...activity, object }],
      }),
      index: (activity, object) => ({
        ...activity,
        "@context": [
          as,
          { objects: { "@id": "as:object", "@container": "@index" } },
        ],
        objects: { en: object },
      }),
    };
    for (const [name, shape] of Object.entries(shapes)) {
      const { object, ...activity } = createOf(alice, name);
      const body = shape(activity, object);
      assert.equal((await send(await signed(signer, body))).status, 202);
      const stored = await db.query.objects.findFirst({
        where: { resource: { iri: `https://remote.example/notes/${name}` } },
      });
      assert.deepEqual(stored?.document, object, name);
      const activityRow = await findActivity(
        db,
        `https://remote.example/activities/${name}`,
      );
      assert.deepEqual(activityRow?.document, body, name);
    }
  });
});

it("stores the object without its document when it lies beyond the places tried", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const { send } = await createRecorder(db, documents);
    const { object, ...activity } = createOf(alice, "far");
    // 70 places come before the object, more than the 64 tried.
    const decoys = Object.fromEntries(
      Array.from({ length: 70 }, (_, index) => [
        `https://example.com/ns#p${index}`,
        { id: `https://remote.example/decoys/${index}`, type: "Note" },
      ]),
    );
    const body = { ...activity, ...decoys, object };
    assert.equal((await send(await signed(signer, body))).status, 202);
    const stored = await db.query.objects.findFirst({
      where: { resource: { iri: "https://remote.example/notes/far" } },
    });
    assert.ok(stored != null);
    assert.equal(stored.document, null);
    const activityRow = await findActivity(
      db,
      "https://remote.example/activities/far",
    );
    assert.deepEqual(activityRow?.document, body);
  });
});

it("stores no text PostgreSQL would refuse or alter, but keeps it received", async () => {
  await withTestHarness(async ({ db }) => {
    await seedLocalInstance(db);
    const documents: Documents = new Map();
    const signer = await addActor(documents, alice);
    const nul = await addActor(documents, "https://remote.example/users/nul", {
      preferredUsername: "a\u0000b",
    });
    const { send } = await createRecorder(db, documents);
    const bodies = [
      createOf(alice, "content", { object: { content: "<p>a\u0000b</p>" } }),
      createOf(alice, "name", { object: { name: "a\u0000b" } }),
      createOf(alice, "summary", { object: { summary: "a\ud800b" } }),
    ];
    for (const body of bodies) {
      assert.equal((await send(await signed(signer, body))).status, 202);
    }
    const username = createOf(nul.iri, "username");
    assert.equal((await send(await signed(nul, username))).status, 202);
    const deliveries = await findDeliveries(db);
    assert.deepEqual(
      deliveries.map((row) => [row.status, row.activityId]),
      Array.from({ length: 4 }, () => ["received", null]),
    );
    for (const [index, body] of [...bodies, username].entries()) {
      assert.equal(
        Buffer.from(deliveries[index]?.body ?? []).toString(),
        JSON.stringify(body),
      );
    }
    assert.deepEqual(await counts(db), {
      instances: 1,
      actors: 0,
      objects: 0,
      activities: 0,
      addressing: 0,
    });
    // Other control characters are text like any other.
    const control = createOf(alice, "control", {
      object: { content: "<p>a\u0001b</p>" },
    });
    assert.equal((await send(await signed(signer, control))).status, 202);
    assert.equal(
      (await db.query.objects.findFirst())?.contentHtml,
      "<p>a\u0001b</p>",
    );
  });
});
