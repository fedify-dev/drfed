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

// Each request observes the preceding request's cache and database changes.

// oxlint-disable no-await-in-loop max-statements id-length
import assert from "node:assert/strict";
import { it } from "node:test";

import createFederation, { type TrackedFederation } from "@drfed/federation";
import {
  classifyInbound,
  createInboundRecorder,
  createKeyCache,
  deliverActivity,
  describeActivity,
} from "@drfed/federation/activity-delivery";
import { schema } from "@drfed/models";
import {
  recordInbound,
  recordOutbound,
  settleOutbound,
} from "@drfed/models/activity-delivery";
import { observeKeyVersion } from "@drfed/models/key";
import {
  type Context,
  type KvKey,
  MemoryKvStore,
  SendActivityError,
  type SenderKeyPair,
  generateCryptoKeyPair,
  signRequest,
} from "@fedify/fedify";
import {
  type Activity,
  Create,
  CryptographicKey,
  type DocumentLoader,
  Multikey,
  Person,
  type Recipient,
} from "@fedify/vocab";
import { eq, isNull } from "drizzle-orm";

import { withInbox } from "./activity-delivery/remote.test.ts";
import { withTemporaryDatabase, withTestHarness } from "./harness.test.ts";
import {
  accountId,
  globalId,
  localActorId,
  localInstanceId,
  remoteActorId,
  remoteInstanceId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedRemoteActor,
} from "./seed.test.ts";

const actorIri = new URL("https://remote.example/users/alice");
const keyId = new URL(`${actorIri.href}#main-key`);
const inbox = `https://test-instance.drfed.org/users/${localActorId}/inbox`;
const fetchOptions = { contextData: undefined };
const rootOrigin = new URL("https://drfed.org");
const observed = {
  verificationResult: "no_signature",
  body: new TextEncoder().encode("{}"),
  created: Temporal.Now.instant(),
  completed: Temporal.Now.instant(),
} as const;
const payload = (id: string) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `https://remote.example/activities/${id}`,
  type: "Create",
  actor: actorIri.href,
  object: {
    id: `https://remote.example/notes/${id}`,
    type: "Note",
    content: "test",
  },
  bcc: ["https://private.example/recipient"],
});
const request = (body: unknown, url = inbox) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/activity+json" },
    body: JSON.stringify(body),
  });

it("records signed, rotated, tampered and rejected inbox deliveries with the original JSON", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const kv = new MemoryKvStore();
    const a = await generateCryptoKeyPair();
    const b = await generateCryptoKeyPair();
    let currentKey = a.publicKey;
    // Fedify fetches the actor on every request to check that it owns the key,
    // so only fetches of the key itself tell whether the cache served it.
    let keyLoads = 0;
    const documentLoader: DocumentLoader = async (url) => {
      if (url === keyId.href) keyLoads += 1;
      const key = new CryptographicKey({
        id: keyId,
        owner: actorIri,
        publicKey: currentKey,
      });
      const document =
        url === actorIri.href
          ? await new Person({ id: actorIri, publicKey: key }).toJsonLd()
          : await key.toJsonLd();
      return { documentUrl: url, contextUrl: null, document };
    };
    const { contextLoader } = (
      await createFederation(db, { kv })
    ).createContext(new URL(inbox), undefined);
    const federation = await createFederation(db, {
      kv,
      contextLoaderFactory: () => contextLoader,
      documentLoaderFactory: () => documentLoader,
    });
    const recorder = createInboundRecorder({ db, federation, rootOrigin });
    const send = async (
      body: unknown,
      privateKey = a.privateKey,
      url = inbox,
    ) => {
      const signed = await signRequest(request(body, url), privateKey, keyId);
      return await recorder.fetch(signed, fetchOptions);
    };
    assert.equal((await send(payload("first"))).status, 202);
    const [first] = await db.query.activityDeliveries.findMany();
    assert.ok(first);
    assert.equal(first.status, "received");
    assert.equal(first.verificationMechanism, "http_signature");
    assert.equal(first.verificationResult, "verified");
    assert.equal(first.error, null);
    assert.equal(first.requestUrl, inbox);
    assert.deepEqual(
      JSON.parse(new TextDecoder().decode(first.body!)),
      payload("first"),
    );
    assert.equal(first.type, "Create");
    assert.equal(first.objectType, "Note");
    assert.equal(first.signedKeyIri, keyId.href);
    assert.ok(first.verificationKeyId);
    assert.equal(first.actorId, localActorId);
    assert.deepEqual(first.payload, payload("first"));
    const [firstVersion] = await db.query.keyVersions.findMany();
    assert.ok(firstVersion);
    // Digest failure happens before a key lookup. An existing cache entry is
    // not evidence that this request used that key.
    const badDigest = await signRequest(
      request(payload("bad-digest")),
      a.privateKey,
      keyId,
    );
    badDigest.headers.set(
      "digest",
      "SHA-256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    assert.equal((await recorder.fetch(badDigest, fetchOptions)).status, 401);
    const digestDelivery = await db.query.activityDeliveries.findFirst({
      where: { activityIri: payload("bad-digest").id },
    });
    assert.equal(digestDelivery?.signedKeyIri, keyId.href);
    assert.equal(digestDelivery?.verificationKeyId, null);
    assert.equal(digestDelivery?.verificationResult, "invalid_signature");
    const digestHeader = new Map(digestDelivery?.headers).get("digest");
    assert.equal(
      digestHeader,
      "SHA-256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    );
    assert.notEqual(
      `SHA-256=${new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new Uint8Array(digestDelivery!.body!),
        ),
      ).toBase64()}`,
      digestHeader,
    );
    assert.equal(keyLoads, 1);
    assert.equal((await send(payload("second"))).status, 202);
    assert.equal(keyLoads, 1);
    assert.equal(await db.$count(schema.keyVersions), 1);
    const [seenAgain] = await db.query.keyVersions.findMany();
    assert.ok(seenAgain);
    assert.ok(
      Temporal.Instant.compare(seenAgain.lastSeen, firstVersion.lastSeen) > 0,
    );
    currentKey = b.publicKey;
    await kv.delete(["_fedify", "publicKey", "2", keyId.href]);
    assert.equal((await send(payload("rotated"), b.privateKey)).status, 202);
    assert.equal(await db.$count(schema.keyVersions), 2);
    assert.equal(
      (await db.query.activityDeliveries.findFirst({ where: { id: first.id } }))
        ?.verificationKeyId,
      firstVersion.id,
    );
    // Sign with A while the advertised key is B: cryptographic verification fails.
    assert.equal((await send(payload("tampered"))).status, 401);
    const bad = await db.query.activityDeliveries.findFirst({
      where: { activityIri: payload("tampered").id },
    });
    assert.equal(bad?.status, "unverified");
    assert.equal(bad?.verificationResult, "invalid_signature");
    assert.ok(bad?.verificationKeyId);
    const mismatch = {
      ...payload("mismatch"),
      actor: "https://other.example/actor",
    };
    assert.equal((await send(mismatch, b.privateKey)).status, 401);
    const rejected = await db.query.activityDeliveries.findFirst({
      where: { activityIri: mismatch.id },
    });
    assert.equal(rejected?.status, "rejected");
    assert.equal(rejected?.verificationResult, "verified");
    assert.equal(rejected?.error, rejected?.responseBody);
    assert.match(rejected?.error ?? "", /do not match/u);
    assert.equal(
      (
        await send(
          payload("shared"),
          b.privateKey,
          "https://test-instance.drfed.org/inbox",
        )
      ).status,
      202,
    );
    assert.equal(
      (
        await db.query.activityDeliveries.findFirst({
          where: { activityIri: payload("shared").id },
        })
      )?.actorId,
      null,
    );
    await kv.delete(["_fedify", "publicKey", "2", keyId.href]);
    assert.equal(await db.$count(schema.keyVersions), 2);
  });
});

it("records missing signatures, failed key fetches and non-JSON bodies, and skips non-inbox requests", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const kv = new MemoryKvStore();
    const { contextLoader } = (
      await createFederation(db, { kv })
    ).createContext(new URL(inbox), undefined);
    const federation = await createFederation(db, {
      kv,
      contextLoaderFactory: () => contextLoader,
      documentLoaderFactory: () => () =>
        Promise.reject(new TypeError("offline")),
    });
    const recorder = createInboundRecorder({ db, federation, rootOrigin });
    assert.equal(
      (await recorder.fetch(request(payload("unsigned")), fetchOptions)).status,
      401,
    );
    const [unsigned] = await db.query.activityDeliveries.findMany();
    assert.ok(unsigned);
    assert.equal(unsigned.status, "unverified");
    assert.equal(unsigned.signedKeyIri, null);
    assert.equal(unsigned.verificationKeyId, null);
    assert.equal(unsigned.verificationMechanism, "http_signature");
    assert.equal(unsigned.verificationResult, "no_signature");
    const pair = await generateCryptoKeyPair();
    assert.equal(
      (
        await recorder.fetch(
          await signRequest(
            request(payload("unavailable")),
            pair.privateKey,
            keyId,
          ),
          fetchOptions,
        )
      ).status,
      401,
    );
    const failed = await db.query.activityDeliveries.findFirst({
      where: { activityIri: payload("unavailable").id },
    });
    assert.equal(failed?.signedKeyIri, keyId.href);
    assert.equal(failed?.verificationKeyId, null);
    assert.equal(failed?.verificationResult, "key_fetch_error");
    assert.match(failed?.error ?? "", /keyFetchError/u);
    const invalid = await recorder.fetch(
      new Request(inbox, { method: "POST", body: "not JSON" }),
      fetchOptions,
    );
    assert.equal(invalid.status, 400);
    const unparsed = await db.query.activityDeliveries.findFirst({
      where: { statusCode: 400 },
    });
    assert.equal(
      new TextDecoder().decode(unparsed?.body ?? undefined),
      "not JSON",
    );
    assert.equal(unparsed?.type, null);
    assert.deepEqual(unparsed?.types, []);
    // Fedify refused the body before verifying anything.
    assert.equal(unparsed?.verificationMechanism, null);
    assert.equal(unparsed?.verificationResult, "unattempted");
    assert.equal(
      await db.$count(
        schema.activityDeliveries,
        isNull(schema.activityDeliveries.payload),
      ),
      1,
    );
    await recorder.fetch(new Request(inbox), fetchOptions);
    await recorder.fetch(
      request({}, "https://test-instance.drfed.org/not-an-inbox"),
      fetchOptions,
    );
    assert.equal(await db.$count(schema.activityDeliveries), 3);
    await recorder.fetch(request(null), fetchOptions);
    assert.equal(await db.$count(schema.activityDeliveries), 4);
    assert.equal(
      await db.$count(
        schema.activityDeliveries,
        isNull(schema.activityDeliveries.payload),
      ),
      1,
    );
    await db.execute(`DROP TABLE activity_deliveries CASCADE`);
    assert.equal(
      (await recorder.fetch(request(payload("log-failure")), fetchOptions))
        .status,
      401,
    );
  });
});

it("uses the Fedify KV serialization for RSA, Multikey, scoped and negative entries", async () => {
  const kv = new MemoryKvStore();
  const cache = createKeyCache(kv);
  const rsa = await generateCryptoKeyPair();
  const key = new CryptographicKey({
    id: keyId,
    owner: actorIri,
    publicKey: rsa.publicKey,
  });
  await cache.set(keyId, key);
  assert.deepEqual(
    await kv.get(["_fedify", "publicKey", "2", keyId.href]),
    await key.toJsonLd(),
  );
  assert.ok((await cache.get(keyId)) instanceof CryptographicKey);
  const ed = await generateCryptoKeyPair("Ed25519");
  const multi = new Multikey({
    id: keyId,
    controller: actorIri,
    publicKey: ed.publicKey,
  });
  await kv.set(
    ["_fedify", "publicKey", "2", keyId.href],
    await multi.toJsonLd(),
  );
  assert.ok((await cache.get(keyId)) instanceof Multikey);
  await cache.set(keyId, null);
  assert.equal(await cache.get(keyId), null);
  await cache.setFetchError(keyId, { error: new TypeError("offline") });
  assert.equal(
    ((await cache.getFetchError(keyId)) as { error: Error }).error.name,
    "TypeError",
  );
  await kv.set(["_fedify", "publicKey", "2", keyId.href], "not a key");
  assert.equal(await cache.get(keyId), undefined);
  // A key at a compatible identifier is wrapped with when its entry expires.
  const scoped = cache.compatibleKeyScope("multikey");
  const entry: KvKey = [
    "_fedify",
    "publicKey",
    "__compatible",
    "multikey",
    keyId.href,
  ];
  const before = Temporal.Now.instant().epochMilliseconds;
  await scoped.set(keyId, multi);
  const stored = await kv.get<{ key: unknown; expires: number }>(entry);
  assert.deepEqual(Object.keys(stored ?? {}).sort(), ["expires", "key"]);
  assert.deepEqual(stored?.key, await multi.toJsonLd());
  assert.ok((stored?.expires ?? 0) > before);
  assert.ok((await scoped.get(keyId)) instanceof Multikey);
  assert.equal(
    await cache.compatibleKeyScope("httpSignature").get(keyId),
    undefined,
  );
  await scoped.set(keyId, null);
  assert.equal((await kv.get<{ key: unknown }>(entry))?.key, null);
  assert.equal(await scoped.get(keyId), null);
  await kv.set(entry, await multi.toJsonLd());
  assert.equal(await scoped.get(keyId), undefined);
  assert.equal(await kv.get(entry), undefined);
});

it("classifies accepted proofs independently of HTTP signature failure and describes malformed JSON-LD", async () => {
  assert.deepEqual(await describeActivity({}), {
    type: null,
    types: [],
    activityIri: null,
    remoteActorIri: null,
    objectType: null,
    objectIri: null,
  });
  assert.equal(
    (await describeActivity({ type: "Extension", id: "urn:test" })).type,
    "Extension",
  );
  for (const [statusCode, handled, verificationResult, status] of [
    [202, true, "no_signature", "received"],
    [202, true, "invalid_signature", "received"],
    [202, false, "verified", "acknowledged"],
    [401, false, "verified", "rejected"],
    [401, false, "unobserved", "unverified"],
    [400, false, "no_signature", "unverified"],
    // Handling threw instead of answering.
    [null, true, "verified", "rejected"],
    [null, false, "unattempted", "unverified"],
  ] as const) {
    assert.equal(
      classifyInbound({ statusCode, handled, verificationResult }),
      status,
    );
  }
  assert.deepEqual(
    await describeActivity({
      "@context": 123,
      type: "Extension",
      id: "urn:test",
      actor: ["unknown"],
      object: "urn:object",
    }),
    {
      type: "Extension",
      types: ["Extension"],
      activityIri: "urn:test",
      remoteActorIri: null,
      objectType: null,
      objectIri: null,
    },
  );
});

it("paginates tied timestamps, filters deliveries and reads verification keys as an instance member", async () => {
  await withTestHarness(async ({ db, post }) => {
    const auth = await seedAuthenticatedLocalInstance(db);
    await seedLocalActor(db);
    const version = await observeKeyVersion(db, {
      iri: keyId.href,
      publicKey: { kty: "RSA", e: "AQAB", n: "test" },
    });
    const created = Temporal.Instant.from("2026-09-01T00:00:00.123456Z");
    const rows = [];
    for (const status of ["received", "unverified", "rejected"] as const) {
      rows.push(
        await recordInbound(db, {
          ...observed,
          instanceId: localInstanceId,
          actorId: localActorId,
          inboxUrl: inbox,
          status,
          type: status === "received" ? "Create" : "Follow",
          verificationKeyId: version.id,
          payload: { bcc: ["private"] },
          created,
        }),
      );
    }
    const outbound = await recordOutbound(db, {
      instanceId: localInstanceId,
      actorId: localActorId,
      inboxUrl: inbox,
      activityIri: "https://local.example/activity",
      type: "Create",
      payload: {},
      created,
    });
    const query = `query($id: ID!, $after: String, $filter: ActivityDeliveryFilter) {
      node(id: $id) { ... on Instance { activityDeliveries(first: 2, after: $after, filter: $filter) {
        edges { cursor node { uuid direction status type payload verificationKey { fingerprint publicKey key { iri versions { edges { node { uuid } } } } } } }
        pageInfo { hasNextPage endCursor }
      } } }
    }`;
    const page = async (after?: string, filter?: Record<string, string>) => {
      const result = await (
        await post(
          {
            query,
            variables: {
              id: globalId("Instance", localInstanceId),
              after,
              filter,
            },
          },
          auth,
        )
      ).json();
      assert.equal(result.errors, undefined, JSON.stringify(result.errors));
      return result.data.node.activityDeliveries;
    };
    const first = await page();
    const second = await page(first.pageInfo.endCursor);
    assert.equal(first.pageInfo.hasNextPage, true);
    assert.equal(second.pageInfo.hasNextPage, false);
    assert.deepEqual(
      [...first.edges, ...second.edges].map(
        (edge: { node: { uuid: string } }) => edge.node.uuid,
      ),
      [outbound, ...rows.toReversed()].map((row) => row.id),
    );
    assert.equal(first.edges[1].node.verificationKey.key.iri, keyId.href);
    assert.equal(
      (await page(undefined, { direction: "outbound" })).edges.length,
      1,
    );
    assert.equal(
      (await page(undefined, { status: "received" })).edges.length,
      1,
    );
    assert.equal((await page(undefined, { type: "Create" })).edges.length, 2);
    const actorResult = await (
      await post(
        {
          query: `{ node(id: "${globalId("Actor", localActorId)}") { ... on Actor { activityDeliveries(first: 10) { edges { node { uuid } } } } } }`,
        },
        auth,
      )
    ).json();
    assert.equal(actorResult.errors, undefined);
    assert.equal(actorResult.data.node.activityDeliveries.edges.length, 4);
  });
});

it("denies anonymous/nonmember access including node typename and remote connections", async () => {
  await withTestHarness(async ({ db, post }) => {
    const auth = await seedAuthenticatedLocalInstance(db);
    await seedLocalActor(db);
    await seedRemoteActor(db);
    const delivery = await recordInbound(db, {
      ...observed,
      instanceId: localInstanceId,
      actorId: localActorId,
      inboxUrl: inbox,
      status: "received",
      payload: {},
    });
    const deliveryId = Buffer.from(`ActivityDelivery:${delivery.id}`).toString(
      "base64",
    );
    const queries = [
      `{ node(id: "${deliveryId}") { __typename } }`,
      `{ node(id: "${globalId("Instance", localInstanceId)}") { ... on Instance { activityDeliveries { pageInfo { hasNextPage } } } } }`,
      `{ node(id: "${globalId("Actor", localActorId)}") { ... on Actor { activityDeliveries { pageInfo { hasNextPage } } } } }`,
    ];
    for (const query of queries) {
      assert.ok((await (await post({ query })).json()).errors?.length);
    }
    await db
      .delete(schema.instanceMembers)
      .where(eq(schema.instanceMembers.accountId, accountId));
    for (const query of queries) {
      assert.ok((await (await post({ query }, auth)).json()).errors?.length);
    }
    await db
      .update(schema.accounts)
      .set({ admin: true })
      .where(eq(schema.accounts.id, accountId));
    assert.equal(
      (await (await post({ query: queries[0]! }, auth)).json()).errors,
      undefined,
    );
    for (const [type, id] of [
      ["Instance", remoteInstanceId],
      ["Actor", remoteActorId],
    ] as const) {
      assert.ok(
        (
          await (
            await post(
              {
                query: `{ node(id: "${globalId(type, id)}") { ... on ${type} { activityDeliveries { pageInfo { hasNextPage } } } } }`,
              },
              auth,
            )
          ).json()
        ).errors?.length,
      );
    }
  });
});

it("pages through the attempts of a delivery, oldest first", async () => {
  await withTestHarness(async ({ db, post }) => {
    const auth = await seedAuthenticatedLocalInstance(db);
    await seedLocalActor(db);
    const outgoing = {
      instanceId: localInstanceId,
      actorId: localActorId,
      inboxUrl: inbox,
      activityIri: "https://local.example/activity",
      payload: {},
    } as const;
    const outbound = await recordOutbound(db, outgoing);
    for (const [status, statusCode, error] of [
      ["failed", 503, "First"],
      ["failed", 502, "Second"],
      ["sent", 202, null],
    ] as const) {
      await settleOutbound(db, {
        ...outgoing,
        status,
        statusCode,
        error,
        attempted: true,
      });
    }
    const inbound = await recordInbound(db, {
      ...observed,
      instanceId: localInstanceId,
      actorId: localActorId,
      inboxUrl: inbox,
      status: "received",
      payload: {},
    });
    const page = async (id: string, first: number, after?: string) => {
      const result = await (
        await post(
          {
            query: `query($id: ID!, $first: Int!, $after: String) {
              node(id: $id) { ... on ActivityDelivery {
                attempts(first: $first, after: $after) {
                  edges { node { succeeded statusCode error } }
                  pageInfo { hasNextPage endCursor }
                }
              } }
            }`,
            variables: {
              id: Buffer.from(`ActivityDelivery:${id}`).toString("base64"),
              first,
              after,
            },
          },
          auth,
        )
      ).json();
      assert.equal(result.errors, undefined, JSON.stringify(result.errors));
      return result.data.node.attempts;
    };
    const attempts = [];
    let after: string | undefined;
    for (const hasNextPage of [true, true, false]) {
      const { edges, pageInfo } = await page(outbound.id, 1, after);
      assert.equal(pageInfo.hasNextPage, hasNextPage);
      attempts.push(...edges.map((edge: { node: unknown }) => edge.node));
      after = pageInfo.endCursor;
    }
    assert.deepEqual(attempts, [
      { succeeded: false, statusCode: 503, error: "First" },
      { succeeded: false, statusCode: 502, error: "Second" },
      { succeeded: true, statusCode: 202, error: null },
    ]);
    assert.deepEqual(await page(inbound.id, 10), {
      edges: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    });
  });
});

it("tells on each edge of an actor's deliveries how the delivery concerns it", async () => {
  await withTestHarness(async ({ db, post }) => {
    const auth = await seedAuthenticatedLocalInstance(db);
    await seedLocalActor(db);
    const followers = "https://remote.example/users/alice/followers";
    const following = "https://remote.example/users/alice/following";
    const at = (minute: number) =>
      Temporal.Instant.from(`2026-09-01T00:0${minute}:00Z`);
    // Inserted in another order than they were created in.
    const owned = await recordInbound(db, {
      ...observed,
      instanceId: localInstanceId,
      actorId: localActorId,
      inboxUrl: inbox,
      status: "received",
      payload: {},
      addressed: [{ actorId: localActorId }],
      created: at(3),
    });
    const shared = await recordInbound(db, {
      ...observed,
      instanceId: localInstanceId,
      inboxUrl: "https://test-instance.drfed.org/inbox",
      status: "received",
      payload: {},
      addressed: [
        { actorId: localActorId, viaCollectionIri: following },
        { actorId: localActorId, viaCollectionIri: followers },
      ],
      created: at(1),
    });
    const sent = await recordOutbound(db, {
      instanceId: localInstanceId,
      actorId: localActorId,
      inboxUrl: "https://remote.example/inbox",
      activityIri: "https://local.example/activity",
      payload: {},
      created: at(2),
    });
    const page = async (
      first: number,
      after?: string,
      filter?: Record<string, string>,
    ) => {
      const result = await (
        await post(
          {
            query: `query($id: ID!, $first: Int!, $after: String, $filter: ActivityDeliveryFilter) {
              node(id: $id) { ... on Actor {
                activityDeliveries(first: $first, after: $after, filter: $filter) {
                  edges {
                    inboxOwner sender addressed addressedDirectly viaCollections
                    node { uuid actor { uuid } }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              } }
            }`,
            variables: {
              id: globalId("Actor", localActorId),
              first,
              after,
              filter,
            },
          },
          auth,
        )
      ).json();
      assert.equal(result.errors, undefined, JSON.stringify(result.errors));
      return result.data.node.activityDeliveries;
    };
    const first = await page(2);
    const second = await page(2, first.pageInfo.endCursor);
    assert.deepEqual(
      [first.pageInfo.hasNextPage, second.pageInfo.hasNextPage],
      [true, false],
    );
    assert.deepEqual(
      [...first.edges, ...second.edges],
      [
        {
          inboxOwner: true,
          sender: false,
          addressed: true,
          addressedDirectly: true,
          viaCollections: [],
          node: { uuid: owned.id, actor: { uuid: localActorId } },
        },
        {
          inboxOwner: false,
          sender: true,
          addressed: false,
          addressedDirectly: false,
          viaCollections: [],
          node: { uuid: sent.id, actor: { uuid: localActorId } },
        },
        {
          inboxOwner: false,
          sender: false,
          addressed: true,
          addressedDirectly: false,
          viaCollections: [followers, following],
          node: { uuid: shared.id, actor: null },
        },
      ],
    );
    const uuids = async (filter: Record<string, string>) =>
      (await page(10, undefined, filter)).edges.map(
        (edge: { node: { uuid: string } }) => edge.node.uuid,
      );
    assert.deepEqual(await uuids({ direction: "outbound" }), [sent.id]);
    assert.deepEqual(await uuids({ direction: "inbound" }), [
      owned.id,
      shared.id,
    ]);
  });
});

/**
 * A key of the test's own to deliver with, since local key pairs arrive with
 * #87.
 * @returns The key pair.
 */
async function testKey(): Promise<SenderKeyPair> {
  const { privateKey } = await generateCryptoKeyPair("Ed25519");
  return { keyId: new URL(`${actorIri.href}#key`), privateKey };
}

it("settles synchronous delivery and retains HTTP failure diagnostics", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const federation = await createFederation(db, {
      kv: new MemoryKvStore(),
      allowPrivateAddress: true,
    });
    const ctx = federation.createContext(new URL(inbox), undefined);
    const key = await testKey();
    const sender = { identifier: localActorId };
    const fakeContext = (
      sendActivity: Context<unknown>["sendActivity"],
    ): Context<unknown> =>
      new Proxy(ctx, {
        get(target, property) {
          return property === "sendActivity"
            ? sendActivity
            : Reflect.get(target, property);
        },
      });
    // Fedify delivers for real: only its report of the delivery makes it sent.
    await withInbox([[202, ""]], async (remote) => {
      const recipient = { id: actorIri, inboxId: remote };
      const activity = new Create({
        id: new URL("https://test-instance.drfed.org/activity/1"),
        actor: ctx.getActorUri(localActorId),
      });
      await deliverActivity(
        db,
        fakeContext((_sender, recipients, sent) =>
          ctx.sendActivity(key, recipients as Recipient[], sent),
        ),
        sender,
        [recipient, recipient],
        activity,
      );
    });
    assert.equal(await db.$count(schema.activityDeliveries), 1);
    const sent = await db.query.activityDeliveries.findFirst({
      with: { attempts: true },
    });
    assert.equal(sent?.status, "sent");
    assert.equal(sent.statusCode, 202);
    assert.ok(sent.completed != null);
    assert.deepEqual(
      sent.attempts.map((attempt) => attempt.succeeded),
      [true],
    );
    // Fedify reports a synchronous failure only by throwing it.
    const recipient = {
      id: actorIri,
      inboxId: new URL("https://remote.example/inbox"),
    };
    const failure = new SendActivityError(
      recipient.inboxId,
      410,
      "gone",
      "Gone forever",
    );
    const failActivity = new Create({
      id: new URL("https://test-instance.drfed.org/activity/2"),
      actor: ctx.getActorUri(localActorId),
    });
    await assert.rejects(
      deliverActivity(
        db,
        fakeContext(() => Promise.reject(failure)),
        sender,
        recipient,
        failActivity,
      ),
      SendActivityError,
    );
    const failed = await db.query.activityDeliveries.findFirst({
      where: { activityIri: failActivity.id!.href },
      with: { attempts: true },
    });
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.statusCode, 410);
    assert.equal(failed?.error, "gone");
    assert.equal(failed?.responseBody, "Gone forever");
    assert.deepEqual(
      failed?.attempts.map((attempt) => [
        attempt.succeeded,
        attempt.statusCode,
        attempt.error,
        attempt.responseBody,
      ]),
      [[false, 410, "gone", "Gone forever"]],
    );
  });
});

it("settles successful inboxes independently from thrown delivery failures", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const federation = await createFederation(db, {
      kv: new MemoryKvStore(),
      allowPrivateAddress: true,
    });
    const context = federation.createContext(new URL(inbox), undefined);
    const key = await testKey();
    const bad = {
      id: actorIri,
      inboxId: new URL("https://remote.example/bad"),
    };
    const activity = new Create({
      id: new URL("https://test-instance.drfed.org/activity/mixed"),
      actor: context.getActorUri(localActorId),
    });
    const ctx = new Proxy(context, {
      get(target, property) {
        if (property !== "sendActivity") return Reflect.get(target, property);
        return (_sender: unknown, recipients: Recipient[], sent: Activity) =>
          recipients[0]?.inboxId?.href === bad.inboxId.href
            ? Promise.reject(
                new SendActivityError(
                  bad.inboxId,
                  503,
                  "unavailable",
                  "Try later",
                ),
              )
            : target.sendActivity(key, recipients, sent);
      },
    });
    await withInbox([[202, ""]], async (remote) => {
      const good = { id: actorIri, inboxId: remote };
      await assert.rejects(
        deliverActivity(
          db,
          ctx,
          { identifier: localActorId },
          [good, bad],
          activity,
        ),
        SendActivityError,
      );
    });
    const rows = await db.query.activityDeliveries.findMany({
      orderBy: { inboxUrl: "asc" },
    });
    assert.equal(rows[0]?.status, "sent");
    assert.equal(rows[0]?.statusCode, 202);
    assert.equal(rows[1]?.status, "failed");
    assert.equal(rows[1]?.statusCode, 503);
    assert.equal(rows[1]?.error, "unavailable");
    assert.equal(rows[1]?.responseBody, "Try later");
  });
});

it("returns a literal JSON null payload without nulling its connection", async () => {
  await withTestHarness(async ({ db, post }) => {
    const auth = await seedAuthenticatedLocalInstance(db);
    await recordInbound(db, {
      ...observed,
      instanceId: localInstanceId,
      inboxUrl: inbox,
      status: "unverified",
      payload: null,
    });
    const result = await (
      await post(
        {
          query: `{ node(id: "${globalId("Instance", localInstanceId)}") { ... on Instance { activityDeliveries(first: 1) { edges { node { status payload } } } } } }`,
        },
        auth,
      )
    ).json();
    assert.equal(result.errors, undefined);
    assert.deepEqual(result.data.node.activityDeliveries.edges[0].node, {
      status: "unverified",
      payload: null,
    });
  });
});

it("skips verification observations for unclaimed hosts and failed instance lookups", async () => {
  await withTemporaryDatabase(async (db) => {
    const kv = new MemoryKvStore();
    const base = await createFederation(db, { kv });
    const pair = await generateCryptoKeyPair();
    let reads = 0;
    const passThrough = new Response("No local instance", { status: 404 });
    const federation = {
      createContext: (input: Request, data: unknown) => {
        const ctx = base.createContext(input, data);
        return new Proxy(ctx, {
          get(target, property) {
            if (property === "documentLoader") {
              return () => {
                reads += 1;
                return Promise.reject(new Error("Unexpected key lookup"));
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      fetch: () => Promise.resolve(passThrough),
    } as unknown as TrackedFederation;
    const recorder = createInboundRecorder({ db, federation, rootOrigin });
    const signed = await signRequest(
      request(payload("unknown-host")),
      pair.privateKey,
      keyId,
    );
    assert.equal(
      await recorder.fetch(signed.clone(), fetchOptions),
      passThrough,
    );
    assert.equal(reads, 0);
    assert.equal(await db.$count(schema.keys), 0);
    assert.equal(await db.$count(schema.keyVersions), 0);
    assert.equal(await db.$count(schema.activityDeliveries), 0);
    await db.execute(
      "ALTER TABLE instances RENAME TO temporarily_unavailable_instances",
    );
    assert.equal(
      await recorder.fetch(signed.clone(), fetchOptions),
      passThrough,
    );
    assert.equal(reads, 0);
    assert.equal(await db.$count(schema.keyVersions), 0);
  });
});
