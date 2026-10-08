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

// oxlint-disable no-await-in-loop max-statements
import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import createFederation, { type TrackedFederation } from "@drfed/federation";
import {
  createInboundRecorder,
  declaredKeyId,
  parseBody,
  recordedHeaders,
} from "@drfed/federation/activity-delivery";
import { instanceUrl } from "@drfed/federation/origin";
import { type Database, addActorCollectionItem, schema } from "@drfed/models";
import {
  type FederationFetchOptions,
  InProcessMessageQueue,
  MemoryKvStore,
  exportJwk,
  generateCryptoKeyPair,
  signJsonLd,
  signObject,
  signRequest,
} from "@fedify/fedify";
import { FetchError } from "@fedify/fedify/runtime";
import {
  Create,
  CryptographicKey,
  type DocumentLoader,
  Multikey,
  Note,
  Person,
} from "@fedify/vocab";
import { eq } from "drizzle-orm";

import { withTemporaryDatabase, withTestHarness } from "../harness.test.ts";
import {
  globalId,
  localActorId,
  localInstanceId,
  remoteActorId,
  seedAuthenticatedLocalInstance,
  seedLocalActor,
  seedRemoteActor,
} from "../seed.test.ts";

const origin = "https://test-instance.drfed.org";
const localActorIri = `${origin}/users/${localActorId}`;
const inbox = `${localActorIri}/inbox`;
const sharedInbox = `${origin}/inbox`;
const actorIri = new URL("https://remote.example/users/alice");
const httpKeyId = new URL(`${actorIri.href}#main-key`);
const ldKeyId = new URL(`${actorIri.href}#ld-key`);
const proofKeyId = new URL(`${actorIri.href}#proof-key`);
const rootOrigin = new URL("https://drfed.org");
const fetchOptions = { contextData: undefined };

const activity = (id: string, extra: Record<string, unknown> = {}) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: `https://remote.example/activities/${id}`,
  type: "Create",
  actor: actorIri.href,
  object: { id: `https://remote.example/notes/${id}`, type: "Note" },
  ...extra,
});
const post = (
  body: string | Uint8Array<ArrayBuffer>,
  url = inbox,
  headers = {},
) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/activity+json", ...headers },
    body,
  });

function keyLoader(
  keys: ReadonlyMap<string, CryptographicKey | Multikey>,
): DocumentLoader {
  return async (url) => {
    const key = keys.get(url);
    if (key == null && url !== actorIri.href) throw new TypeError("offline");
    const document =
      key == null
        ? await new Person({
            id: actorIri,
            publicKeys: [...keys.values()].filter(
              (value) => value instanceof CryptographicKey,
            ),
            assertionMethods: [...keys.values()].filter(
              (value) => value instanceof Multikey,
            ),
          }).toJsonLd()
        : await key.toJsonLd();
    return { documentUrl: url, contextUrl: null, document };
  };
}

async function createRecorder(
  db: Database,
  keys: ReadonlyMap<string, CryptographicKey | Multikey> = new Map(),
  { kv = new MemoryKvStore(), documentLoader = keyLoader(keys) } = {},
) {
  const { contextLoader } = (await createFederation(db, { kv })).createContext(
    new URL(inbox),
    undefined,
  );
  const federation = await createFederation(db, {
    kv,
    contextLoaderFactory: () => contextLoader,
    documentLoaderFactory: () => documentLoader,
    authenticatedDocumentLoaderFactory: () => documentLoader,
  });
  const recorder = createInboundRecorder({ db, federation, rootOrigin });
  return {
    contextLoader,
    send: (request: Request) => recorder.fetch(request, fetchOptions),
  };
}
const findDeliveries = (db: Database) =>
  db.query.activityDeliveries.findMany({
    orderBy: { id: "asc" },
    with: {
      verificationKey: { with: { key: true } },
      actorLinks: {
        with: { collections: { orderBy: { collectionIri: "asc" } } },
      },
    },
  });

it("records the key of the Linked Data Signature that verified, not of the HTTP signature", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const http = await generateCryptoKeyPair();
    const ld = await generateCryptoKeyPair();
    const { contextLoader, send } = await createRecorder(
      db,
      new Map([
        [
          ldKeyId.href,
          new CryptographicKey({
            id: ldKeyId,
            owner: actorIri,
            publicKey: ld.publicKey,
          }),
        ],
        [
          httpKeyId.href,
          new CryptographicKey({
            id: httpKeyId,
            owner: actorIri,
            publicKey: http.publicKey,
          }),
        ],
      ]),
    );
    const signed = await signJsonLd(activity("ld"), ld.privateKey, ldKeyId, {
      contextLoader,
    });
    const response = await send(
      await signRequest(
        post(JSON.stringify(signed)),
        http.privateKey,
        httpKeyId,
      ),
    );
    assert.equal(response.status, 202);
    const [delivery] = await findDeliveries(db);
    assert.equal(delivery?.status, "received");
    assert.equal(delivery?.verificationMechanism, "ld_signature");
    assert.equal(delivery?.verificationResult, "verified");
    assert.equal(delivery?.verificationKey?.key.iri, ldKeyId.href);
    assert.equal(delivery?.signedKeyIri, httpKeyId.href);
    assert.equal(await db.$count(schema.keys), 1);
    const broken = { ...signed, id: "https://remote.example/activities/x" };
    assert.equal((await send(post(JSON.stringify(broken)))).status, 401);
    const failed = (await findDeliveries(db))[1];
    assert.equal(failed?.status, "unverified");
    assert.equal(failed?.verificationMechanism, "ld_signature");
    assert.equal(failed?.verificationResult, "invalid_signature");
    assert.equal(failed?.signedKeyIri, null);
  });
});

it("records an Object Integrity Proof, and acknowledges a duplicate without receiving it again", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const pair = await generateCryptoKeyPair("Ed25519");
    const { contextLoader, send } = await createRecorder(
      db,
      new Map([
        [
          proofKeyId.href,
          new Multikey({
            id: proofKeyId,
            controller: actorIri,
            publicKey: pair.publicKey,
          }),
        ],
      ]),
    );
    const signed = await signObject(
      new Create({
        id: new URL("https://remote.example/activities/proof"),
        actor: actorIri,
        object: new Note({ id: new URL("https://remote.example/notes/proof") }),
      }),
      pair.privateKey,
      proofKeyId,
      { contextLoader },
    );
    const body = JSON.stringify(
      await signed.toJsonLd({ format: "compact", contextLoader }),
    );
    assert.equal((await send(post(body))).status, 202);
    assert.equal((await send(post(body))).status, 202);
    const [first, second] = await findDeliveries(db);
    for (const delivery of [first, second]) {
      assert.equal(delivery?.verificationMechanism, "object_integrity_proof");
      assert.equal(delivery?.verificationResult, "verified");
      assert.equal(delivery?.verificationKey?.key.iri, proofKeyId.href);
      assert.equal(delivery?.signedKeyIri, null);
      assert.equal(delivery?.error, null);
    }
    assert.equal(first?.status, "received");
    assert.equal(second?.status, "acknowledged");
    assert.match(second?.responseBody ?? "", /already been processed/u);
  });
});

it("records the key of an Object Integrity Proof at an FEP-ef61 compatible identifier", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    // Fedify caches a key at such an identifier only apart for each purpose.
    const compatibleKeyId = new URL(
      "https://remote.example/.well-known/apgateway/did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK/actor#key",
    );
    const pair = await generateCryptoKeyPair("Ed25519");
    const { contextLoader, send } = await createRecorder(
      db,
      new Map([
        [
          compatibleKeyId.href,
          new Multikey({
            id: compatibleKeyId,
            controller: actorIri,
            publicKey: pair.publicKey,
          }),
        ],
      ]),
    );
    const signed = await signObject(
      new Create({
        id: new URL("https://remote.example/activities/compatible"),
        actor: actorIri,
        object: new Note({
          id: new URL("https://remote.example/notes/compatible"),
        }),
      }),
      pair.privateKey,
      compatibleKeyId,
      { contextLoader },
    );
    const body = JSON.stringify(
      await signed.toJsonLd({ format: "compact", contextLoader }),
    );
    // Fedify fetches the key the first time, and reads its cache the second.
    assert.equal((await send(post(body))).status, 202);
    assert.equal((await send(post(body))).status, 202);
    const [first, second] = await findDeliveries(db);
    assert.equal(first?.status, "received");
    assert.equal(first?.verificationMechanism, "object_integrity_proof");
    assert.equal(first?.verificationResult, "verified");
    assert.notEqual(first?.verificationKeyId, null);
    assert.equal(first?.verificationKey?.key.iri, compatibleKeyId.href);
    assert.equal(
      first?.verificationKey?.publicKey.x,
      (await exportJwk(pair.publicKey)).x,
    );
    assert.equal(second?.verificationResult, "verified");
    assert.equal(second?.verificationKeyId, first?.verificationKeyId);
  });
});

it("records the key Fedify verified with, whatever a later fetch returns", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const [first, rotated] = [
      await generateCryptoKeyPair(),
      await generateCryptoKeyPair(),
    ];
    const key = ({ publicKey }: CryptoKeyPair) =>
      new CryptographicKey({ id: httpKeyId, owner: actorIri, publicKey });
    const modulus = async ({ publicKey }: CryptoKeyPair) =>
      (await exportJwk(publicKey)).n;
    // The key IRI serves the first key once, and the rotated one after.
    const keys = new Map([[httpKeyId.href, key(first)]]);
    let fetched = 0;
    const serve = keyLoader(keys);
    const kv = new MemoryKvStore();
    const { send } = await createRecorder(db, keys, {
      kv,
      documentLoader: async (url) => {
        const document = await serve(url);
        if (url === httpKeyId.href) {
          fetched += 1;
          keys.set(httpKeyId.href, key(rotated));
        }
        return document;
      },
    });
    const signed = () =>
      signRequest(
        post(JSON.stringify(activity(`rotated-${fetched}`))),
        rotated.privateKey,
        httpKeyId,
      );
    // Fedify fetches the first key once, and it does not verify.
    const refused = await send(await signed());
    assert.equal(refused.status, 401);
    assert.equal(fetched, 1);
    // Cached now, it fails again; Fedify refetches, and the rotated key verifies.
    const accepted = await send(await signed());
    assert.equal(accepted.status, 202);
    assert.equal(fetched, 2);
    const [refusal, acceptance] = await findDeliveries(db);
    assert.equal(refusal?.status, "unverified");
    assert.equal(refusal?.verificationResult, "invalid_signature");
    assert.equal(refusal?.verificationKey?.publicKey.n, await modulus(first));
    assert.equal(acceptance?.status, "received");
    assert.equal(acceptance?.verificationResult, "verified");
    assert.equal(
      acceptance?.verificationKey?.publicKey.n,
      await modulus(rotated),
    );
  });
});

it("records the key Fedify verified with, even when fetching it again failed", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const [cached, rotated] = [
      await generateCryptoKeyPair(),
      await generateCryptoKeyPair(),
    ];
    const keys = new Map([
      [
        httpKeyId.href,
        new CryptographicKey({
          id: httpKeyId,
          owner: actorIri,
          publicKey: cached.publicKey,
        }),
      ],
    ]);
    const serve = keyLoader(keys);
    let online = true;
    const { send } = await createRecorder(db, keys, {
      documentLoader: async (url) => {
        if (!online) throw new TypeError("offline");
        return await serve(url);
      },
    });
    const signed = (id: string, { privateKey }: CryptoKeyPair) =>
      signRequest(post(JSON.stringify(activity(id))), privateKey, httpKeyId);
    assert.equal((await send(await signed("cached", cached))).status, 202);
    // The cached key does not verify, and fetching it again fails.
    online = false;
    assert.equal((await send(await signed("offline", rotated))).status, 401);
    const [, refusal] = await findDeliveries(db);
    assert.equal(refusal?.status, "unverified");
    assert.equal(refusal?.verificationResult, "key_fetch_error");
    assert.equal(
      refusal?.verificationKey?.publicKey.n,
      (await exportJwk(cached.publicKey)).n,
    );
  });
});

it("records a signature or proof sent to an unknown inbox as unattempted", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const { contextLoader, send } = await createRecorder(db);
    const proven = await (
      await signObject(
        new Create({
          id: new URL("https://remote.example/activities/unknown-proof"),
          actor: actorIri,
          object: new Note({
            id: new URL("https://remote.example/notes/unknown-proof"),
          }),
        }),
        (await generateCryptoKeyPair("Ed25519")).privateKey,
        proofKeyId,
        { contextLoader },
      )
    ).toJsonLd({ format: "compact", contextLoader });
    const signed = await signJsonLd(
      activity("unknown-ld"),
      (await generateCryptoKeyPair()).privateKey,
      ldKeyId,
      { contextLoader },
    );
    const unknown = `${origin}/users/00000000-0000-4000-8000-000000000299/inbox`;
    for (const document of [proven, signed]) {
      const response = await send(post(JSON.stringify(document), unknown));
      assert.equal(response.status, 404);
    }
    const recorded = await findDeliveries(db);
    assert.equal(recorded.length, 2);
    for (const delivery of recorded) {
      assert.equal(delivery.verificationMechanism, null);
      assert.equal(delivery.verificationResult, "unattempted");
      assert.equal(delivery.verificationKey, null);
    }
  });
});

it("keeps a delivery whose JSON PostgreSQL cannot store, with its octets", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const pair = await generateCryptoKeyPair();
    const { send } = await createRecorder(
      db,
      new Map([
        [
          httpKeyId.href,
          new CryptographicKey({
            id: httpKeyId,
            owner: actorIri,
            publicKey: pair.publicKey,
          }),
        ],
      ]),
    );
    const signed = [
      JSON.stringify(activity("nul", { summary: "\u0000" })),
      JSON.stringify(activity("surrogate", { summary: "\ud800" })),
    ];
    for (const body of signed) {
      const request = await signRequest(post(body), pair.privateKey, httpKeyId);
      assert.equal((await send(request)).status, 202);
    }
    // Nor does text hold NUL, whatever an activity that does not parse names.
    const unparsed = JSON.stringify({
      type: "Create\u0000",
      id: `${actorIri.href}/activities/\u0000`,
      actor: `${actorIri.href}\u0000`,
    });
    await send(post(unparsed));
    const recorded = await findDeliveries(db);
    assert.deepEqual(
      recorded.map((delivery) =>
        new TextDecoder().decode(delivery.body ?? undefined),
      ),
      [...signed, unparsed],
    );
    for (const delivery of recorded) assert.equal(delivery.payload, null);
    const [nul, surrogate, raw] = recorded;
    for (const delivery of [nul, surrogate]) {
      assert.equal(delivery?.status, "received");
      assert.equal(delivery?.verificationResult, "verified");
      assert.equal(delivery?.statusCode, 202);
    }
    assert.equal(nul?.activityIri, "https://remote.example/activities/nul");
    assert.deepEqual(
      [raw?.type, raw?.types, raw?.activityIri, raw?.remoteActorIri],
      [null, [], null, null],
    );
  });
});

it("records a request Fedify throws on, and throws the exception again", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const pair = await generateCryptoKeyPair();
    const kv = new MemoryKvStore();
    const { contextLoader } = (
      await createFederation(db, { kv })
    ).createContext(new URL(inbox), undefined);
    const context = "https://remote.example/context";
    const federation = await createFederation(db, {
      kv,
      // The remote context does not load, whoever asks for it.
      contextLoaderFactory: () => (url, options) =>
        url === context
          ? Promise.reject(new TypeError("offline"))
          : contextLoader(url, options),
      documentLoaderFactory: () =>
        keyLoader(
          new Map([
            [
              httpKeyId.href,
              new CryptographicKey({
                id: httpKeyId,
                owner: actorIri,
                publicKey: pair.publicKey,
              }),
            ],
          ]),
        ),
      authenticatedDocumentLoaderFactory: () =>
        keyLoader(
          new Map([
            [
              httpKeyId.href,
              new CryptographicKey({
                id: httpKeyId,
                owner: actorIri,
                publicKey: pair.publicKey,
              }),
            ],
          ]),
        ),
    });
    const recorder = createInboundRecorder({ db, federation, rootOrigin });
    const body = JSON.stringify(
      activity("thrown", {
        "@context": ["https://www.w3.org/ns/activitystreams", context],
      }),
    );
    const request = await signRequest(post(body), pair.privateKey, httpKeyId);
    await assert.rejects(recorder.fetch(request, fetchOptions), {
      name: "jsonld.InvalidUrl",
    });
    const [delivery, ...rest] = await findDeliveries(db);
    assert.deepEqual(rest, []);
    assert.deepEqual(
      [delivery?.status, delivery?.statusCode, delivery?.responseBody],
      ["unverified", null, null],
    );
    assert.match(delivery?.error ?? "", /^jsonld\.InvalidUrl: /u);
    assert.equal(new TextDecoder().decode(delivery?.body ?? undefined), body);
    assert.equal(
      delivery?.activityIri,
      "https://remote.example/activities/thrown",
    );
    assert.equal(delivery?.verificationResult, "unattempted");
    assert.equal(delivery?.signedKeyIri, httpKeyId.href);
    assert.ok(delivery?.completed != null);
  });
});

it("records the key of an Object Integrity Proof that fails, and of one keyed by its full IRI", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const pair = await generateCryptoKeyPair("Ed25519");
    const { contextLoader, send } = await createRecorder(
      db,
      new Map([
        [
          proofKeyId.href,
          new Multikey({
            id: proofKeyId,
            controller: actorIri,
            publicKey: pair.publicKey,
          }),
        ],
      ]),
    );
    const sign = async (id: string) =>
      (await (
        await signObject(
          new Create({
            id: new URL(`https://remote.example/activities/${id}`),
            actor: actorIri,
            object: new Note({
              id: new URL(`https://remote.example/notes/${id}`),
              content: "original",
            }),
          }),
          pair.privateKey,
          proofKeyId,
          { contextLoader },
        )
      ).toJsonLd({ format: "compact", contextLoader })) as Record<
        string,
        unknown
      >;
    const tampered = await sign("tampered");
    const object = tampered.object as Record<string, unknown>;
    tampered.object = { ...object, content: "tampered" };
    assert.equal((await send(post(JSON.stringify(tampered)))).status, 401);
    const { proof, ...expanded } = await sign("expanded");
    const full = { ...expanded, "https://w3id.org/security#proof": proof };
    assert.equal((await send(post(JSON.stringify(full)))).status, 202);
    const [failed, verified] = await findDeliveries(db);
    assert.equal(failed?.verificationMechanism, "object_integrity_proof");
    assert.equal(failed?.verificationResult, "invalid_signature");
    assert.equal(failed?.verificationKey?.key.iri, proofKeyId.href);
    assert.equal(verified?.status, "received");
    assert.equal(verified?.verificationMechanism, "object_integrity_proof");
    assert.equal(verified?.verificationResult, "verified");
    assert.equal(verified?.verificationKey?.key.iri, proofKeyId.href);
  });
});

it("tells a key that could not be fetched from a signature that did not verify", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const rsa = await generateCryptoKeyPair();
    const ed = await generateCryptoKeyPair("Ed25519");
    // Every key is of a server that fails as the fragment of its IRI says.
    const keyIri = (mechanism: string, failure: string) =>
      new URL(`${actorIri.href}#${mechanism}-${failure}`);
    const { contextLoader, send } = await createRecorder(db, new Map(), {
      documentLoader: async (url) => {
        if (url.endsWith("-gone")) {
          throw new FetchError(url, "Gone", new Response("", { status: 410 }));
        }
        if (!url.endsWith("-invalid")) throw new TypeError("offline");
        const document = await new Note({ id: new URL(url) }).toJsonLd();
        return { documentUrl: url, contextUrl: null, document };
      },
    });
    const requests = {
      ld_signature: async (id: string, key: URL) =>
        post(
          JSON.stringify(
            await signJsonLd(activity(id), rsa.privateKey, key, {
              contextLoader,
            }),
          ),
        ),
      object_integrity_proof: async (id: string, key: URL) => {
        const signed = await signObject(
          new Create({
            id: new URL(`https://remote.example/activities/${id}`),
            actor: actorIri,
            object: new Note({
              id: new URL(`https://remote.example/notes/${id}`),
            }),
          }),
          ed.privateKey,
          key,
          { contextLoader },
        );
        return post(
          JSON.stringify(
            await signed.toJsonLd({ format: "compact", contextLoader }),
          ),
        );
      },
      http_signature: (id: string, key: URL) =>
        signRequest(post(JSON.stringify(activity(id))), rsa.privateKey, key),
    };
    // Fedify names why an HTTP signature's key was not fetched itself.
    const causes = {
      ld_signature: [
        "TypeError: offline",
        "TypeError: offline",
        "410",
        "invalidSignature",
      ],
      object_integrity_proof: [
        "TypeError: offline",
        "TypeError: offline",
        "410",
        "invalidSignature",
      ],
      http_signature: [
        "TypeError: offline",
        "TypeError: offline",
        "410",
        "invalidSignature",
      ],
    };
    for (const mechanism of [
      "ld_signature",
      "object_integrity_proof",
      "http_signature",
    ] as const) {
      const sign = requests[mechanism];
      // The second request finds the failure of the first in the cache.
      for (const [index, failure] of [
        "offline",
        "offline",
        "gone",
        "invalid",
      ].entries()) {
        const id = `${mechanism}-${failure}-${index}`;
        const response = await send(await sign(id, keyIri(mechanism, failure)));
        assert.equal(response.status, 401, id);
        const delivery = (await findDeliveries(db)).at(-1);
        assert.equal(delivery?.status, "unverified", id);
        assert.equal(delivery?.verificationMechanism, mechanism, id);
        assert.equal(
          delivery?.verificationResult,
          failure === "invalid" ? "invalid_signature" : "key_fetch_error",
          id,
        );
        assert.equal(delivery?.verificationKey, null, id);
        assert.equal(
          delivery?.error,
          failure === "invalid"
            ? "invalidSignature"
            : `keyFetchError: ${causes[mechanism][index]}`,
          id,
        );
      }
    }
  });
});

it("records the key a signature or proof failed with, when fetching it again failed", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const rsa = [await generateCryptoKeyPair(), await generateCryptoKeyPair()];
    const ed = [
      await generateCryptoKeyPair("Ed25519"),
      await generateCryptoKeyPair("Ed25519"),
    ];
    const keys = new Map<string, CryptographicKey | Multikey>([
      [
        ldKeyId.href,
        new CryptographicKey({
          id: ldKeyId,
          owner: actorIri,
          publicKey: rsa[0]!.publicKey,
        }),
      ],
      [
        proofKeyId.href,
        new Multikey({
          id: proofKeyId,
          controller: actorIri,
          publicKey: ed[0]!.publicKey,
        }),
      ],
    ]);
    const serve = keyLoader(keys);
    let online = true;
    const { contextLoader, send } = await createRecorder(db, keys, {
      documentLoader: async (url) => {
        if (!online) throw new TypeError("offline");
        return await serve(url);
      },
    });
    const ld = async (id: string, { privateKey }: CryptoKeyPair) =>
      post(
        JSON.stringify(
          await signJsonLd(activity(id), privateKey, ldKeyId, {
            contextLoader,
          }),
        ),
      );
    const proof = async (id: string, { privateKey }: CryptoKeyPair) => {
      const signed = await signObject(
        new Create({
          id: new URL(`https://remote.example/activities/${id}`),
          actor: actorIri,
          object: new Note({
            id: new URL(`https://remote.example/notes/${id}`),
          }),
        }),
        privateKey,
        proofKeyId,
        { contextLoader },
      );
      return post(
        JSON.stringify(
          await signed.toJsonLd({ format: "compact", contextLoader }),
        ),
      );
    };
    assert.equal((await send(await ld("ld-cached", rsa[0]!))).status, 202);
    assert.equal((await send(await proof("proof-cached", ed[0]!))).status, 202);
    // The cached keys do not verify, and fetching them again fails.
    online = false;
    assert.equal((await send(await ld("ld-offline", rsa[1]!))).status, 401);
    assert.equal(
      (await send(await proof("proof-offline", ed[1]!))).status,
      401,
    );
    const [, , ldRefusal, proofRefusal] = await findDeliveries(db);
    for (const [refusal, mechanism, keyId] of [
      [ldRefusal, "ld_signature", ldKeyId],
      [proofRefusal, "object_integrity_proof", proofKeyId],
    ] as const) {
      assert.equal(refusal?.verificationMechanism, mechanism);
      assert.equal(refusal?.verificationResult, "key_fetch_error");
      assert.equal(refusal?.error, "keyFetchError: TypeError: offline");
      assert.equal(refusal?.verificationKey?.key.iri, keyId.href);
    }
    assert.equal(
      ldRefusal?.verificationKey?.publicKey.n,
      (await exportJwk(rsa[0]!.publicKey)).n,
    );
  });
});

it("records the key each verification used, not one another found under the same IRI", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const rsa = await generateCryptoKeyPair();
    const ed = await generateCryptoKeyPair("Ed25519");
    // The proof and the HTTP signature name one IRI, which serves a Multikey.
    const { contextLoader, send } = await createRecorder(
      db,
      new Map([
        [
          proofKeyId.href,
          new Multikey({
            id: proofKeyId,
            controller: actorIri,
            publicKey: ed.publicKey,
          }),
        ],
      ]),
    );
    const signed = (await (
      await signObject(
        new Create({
          id: new URL("https://remote.example/activities/shared-iri"),
          actor: actorIri,
          object: new Note({
            id: new URL("https://remote.example/notes/shared-iri"),
            content: "original",
          }),
        }),
        ed.privateKey,
        proofKeyId,
        { contextLoader },
      )
    ).toJsonLd({ format: "compact", contextLoader })) as Record<
      string,
      unknown
    >;
    const object = signed.object as Record<string, unknown>;
    const tampered = { ...signed, object: { ...object, content: "tampered" } };
    const request = await signRequest(
      post(JSON.stringify(tampered)),
      rsa.privateKey,
      proofKeyId,
    );
    assert.equal((await send(request)).status, 401);
    const [delivery] = await findDeliveries(db);
    assert.equal(delivery?.status, "unverified");
    assert.equal(delivery?.verificationMechanism, "http_signature");
    assert.equal(delivery?.verificationResult, "invalid_signature");
    assert.equal(delivery?.error, "invalidSignature");
    assert.equal(delivery?.signedKeyIri, proofKeyId.href);
    // The proof read the Ed25519 key; the HTTP signature found none to use.
    assert.equal(delivery?.verificationKey, null);
    // A Linked Data Signature and the HTTP signature name one key, too.
    const [cached, rotated] = [
      await generateCryptoKeyPair(),
      await generateCryptoKeyPair(),
    ];
    const keys = new Map([
      [
        httpKeyId.href,
        new CryptographicKey({
          id: httpKeyId,
          owner: actorIri,
          publicKey: cached.publicKey,
        }),
      ],
    ]);
    const serve = keyLoader(keys);
    let online = true;
    const shared = await createRecorder(db, keys, {
      documentLoader: async (url) => {
        if (!online) throw new TypeError("offline");
        return await serve(url);
      },
    });
    const ld = async (id: string, { privateKey }: CryptoKeyPair) =>
      post(
        JSON.stringify(
          await signJsonLd(activity(id), privateKey, httpKeyId, {
            contextLoader: shared.contextLoader,
          }),
        ),
      );
    const accepted = await shared.send(await ld("shared-cached", cached));
    assert.equal(accepted.status, 202);
    // The former fails with the cached key, and empties the entry fetching it
    // again; the latter then finds no key, and so uses none.
    online = false;
    const both = await signRequest(
      await ld("shared-offline", rotated),
      rotated.privateKey,
      httpKeyId,
    );
    assert.equal((await shared.send(both)).status, 401);
    const refusal = (await findDeliveries(db)).at(-1);
    assert.equal(refusal?.verificationMechanism, "http_signature");
    assert.equal(refusal?.verificationResult, "key_fetch_error");
    assert.equal(refusal?.signedKeyIri, httpKeyId.href);
    assert.equal(refusal?.verificationKey, null);
  });
});

it("records a proof that verified as verified, though it does not authenticate the actor", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const rsa = await generateCryptoKeyPair();
    const ed = await generateCryptoKeyPair("Ed25519");
    const { contextLoader, send } = await createRecorder(
      db,
      new Map<string, CryptographicKey | Multikey>([
        [
          proofKeyId.href,
          new Multikey({
            id: proofKeyId,
            controller: actorIri,
            publicKey: ed.publicKey,
          }),
        ],
      ]),
    );
    // Alice's key signs an activity that names Bob as its actor.
    const prove = async (id: string) =>
      JSON.stringify(
        await (
          await signObject(
            new Create({
              id: new URL(`https://remote.example/activities/${id}`),
              actor: new URL("https://remote.example/users/bob"),
              object: new Note({
                id: new URL(`https://remote.example/notes/${id}`),
              }),
            }),
            ed.privateKey,
            proofKeyId,
            { contextLoader },
          )
        ).toJsonLd({ format: "compact", contextLoader }),
      );
    assert.equal((await send(post(await prove("bob")))).status, 401);
    // Nor does an HTTP signature that fails make the proof one that failed.
    const unsigned = await signRequest(
      post(await prove("bob-http")),
      rsa.privateKey,
      httpKeyId,
    );
    assert.equal((await send(unsigned)).status, 401);
    const recorded = await findDeliveries(db);
    assert.equal(recorded.length, 2);
    for (const delivery of recorded) {
      assert.equal(delivery.status, "rejected");
      assert.equal(delivery.verificationMechanism, "object_integrity_proof");
      assert.equal(delivery.verificationResult, "verified");
      assert.equal(delivery.verificationKey?.key.iri, proofKeyId.href);
      assert.equal(delivery.verificationKey?.publicKey.kty, "OKP");
      assert.match(delivery.error ?? "", /uncoveredAttribution/u);
    }
    assert.deepEqual(
      recorded.map((delivery) => delivery.signedKeyIri),
      [null, httpKeyId.href],
    );
  });
});

it("receives a queued activity once the queue worker runs its listener", async () => {
  for (const workerFirst of [false, true]) {
    await withTemporaryDatabase(async (db) => {
      await seedLocalActor(db);
      const pair = await generateCryptoKeyPair("Ed25519");
      const kv = new MemoryKvStore();
      const { contextLoader } = (
        await createFederation(db, { kv })
      ).createContext(new URL(inbox), undefined);
      const federation = await createFederation(db, {
        kv,
        queue: new InProcessMessageQueue(),
        manuallyStartQueue: true,
        contextLoaderFactory: () => contextLoader,
        documentLoaderFactory: () =>
          keyLoader(
            new Map([
              [
                proofKeyId.href,
                new Multikey({
                  id: proofKeyId,
                  controller: actorIri,
                  publicKey: pair.publicKey,
                }),
              ],
            ]),
          ),
        authenticatedDocumentLoaderFactory: () =>
          keyLoader(
            new Map([
              [
                proofKeyId.href,
                new Multikey({
                  id: proofKeyId,
                  controller: actorIri,
                  publicKey: pair.publicKey,
                }),
              ],
            ]),
          ),
      });
      const controller = new AbortController();
      const start = () =>
        federation.startQueue(undefined, { signal: controller.signal });
      // Holding the recorder back lets the worker finish before the delivery
      // exists.
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      const recorder = createInboundRecorder({
        db: workerFirst
          ? new Proxy(db, {
              get(target, property) {
                const value: unknown = Reflect.get(target, property, target);
                if (property !== "transaction" || typeof value !== "function") {
                  return value;
                }
                return async (...args: unknown[]) => {
                  await held;
                  return (value as (...values: unknown[]) => unknown).apply(
                    target,
                    args,
                  );
                };
              },
            })
          : db,
        federation,
        rootOrigin,
      });
      const signed = await signObject(
        new Create({
          id: new URL("https://remote.example/activities/queued"),
          actor: actorIri,
          object: new Note({ id: new URL("https://remote.example/notes/q") }),
        }),
        pair.privateKey,
        proofKeyId,
        { contextLoader },
      );
      const body = JSON.stringify(
        await signed.toJsonLd({ format: "compact", contextLoader }),
      );
      const worker = workerFirst ? start() : undefined;
      const response = recorder.fetch(post(body), fetchOptions);
      if (workerFirst) {
        await sleep(300);
        release();
      }
      assert.equal((await response).status, 202);
      const running = worker ?? start();
      try {
        let status: string | undefined;
        for (let tries = 0; tries < 300 && status !== "received"; tries += 1) {
          await sleep(10);
          status = (await db.query.activityDeliveries.findFirst())?.status;
        }
        assert.equal(status, "received", `worker first: ${workerFirst}`);
      } finally {
        controller.abort();
        await running;
      }
    });
  }
});

it("touches neither the database nor the body of a request that is not an inbox POST", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const kv = new MemoryKvStore();
    const base = await createFederation(db, { kv });
    let queries = 0;
    const counting = new Proxy(db, {
      get(target, property) {
        queries += 1;
        return Reflect.get(target, property);
      },
    });
    const passThrough = new Response("passed through");
    const federation = {
      createContext: base.createContext.bind(base),
      fetch: () => Promise.resolve(passThrough),
    } as unknown as TrackedFederation;
    const recorder = createInboundRecorder({
      db: counting,
      federation,
      rootOrigin,
    });
    const requests = [
      new Request(localActorIri),
      new Request(inbox),
      post("{}", `${origin}/users/${localActorId}/outbox`),
    ];
    for (const request of requests) {
      assert.equal(await recorder.fetch(request, fetchOptions), passThrough);
      assert.equal(request.bodyUsed, false);
    }
    assert.equal(queries, 0);
    assert.equal(await db.$count(schema.activityDeliveries), 0);
  });
});

it("keeps the received octets and headers while parsing a payload for querying", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const { send } = await createRecorder(db);
    const body = `{ "@context": "https://www.w3.org/ns/activitystreams",  "id": "urn:dup", "type":"Create", "actor": "${actorIri.href}", "summary": "a", "summary": "b" }`;
    assert.equal(
      (
        await send(
          post(body, inbox, {
            cookie: "session=secret",
            authorization: "Bearer secret",
          }),
        )
      ).status,
      401,
    );
    const invalidUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
    assert.equal((await send(post(invalidUtf8))).status, 400);
    const [duplicated, binary] = await findDeliveries(db);
    assert.equal(new TextDecoder().decode(duplicated?.body ?? undefined), body);
    assert.deepEqual(duplicated?.payload, {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "urn:dup",
      type: "Create",
      actor: actorIri.href,
      summary: "b",
    });
    const headers = new Map(duplicated?.headers);
    assert.equal(headers.get("content-type"), "application/activity+json");
    assert.equal(headers.get("authorization"), "Bearer");
    assert.equal(headers.has("cookie"), false);
    assert.deepEqual(new Uint8Array(binary?.body ?? []), invalidUtf8);
    assert.equal(binary?.statusCode, 400);
    assert.equal(binary?.status, "unverified");
    assert.equal(binary?.responseBody, "Invalid JSON.");
    assert.equal(binary?.error, "invalidJson");
  });
  assert.equal(parseBody(new TextEncoder().encode("nope")), undefined);
  assert.equal(parseBody(new TextEncoder().encode("null")), null);
  const signature =
    'Signature keyId="https://remote.example/key",headers="date"';
  assert.deepEqual(
    recordedHeaders(new Headers({ Authorization: signature, Cookie: "a=b" })),
    [["authorization", signature]],
  );
  assert.equal(
    declaredKeyId(new Headers({ authorization: signature })),
    "https://remote.example/key",
  );
  assert.equal(
    declaredKeyId(
      new Headers({ "signature-input": 'sig1=("@method");keyid="urn:k"' }),
    ),
    "urn:k",
  );
  assert.equal(declaredKeyId(new Headers({ authorization: "Bearer x" })), null);
});

it("stores the canonical inbox IRI apart from the URL a request arrived at", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const { send } = await createRecorder(db);
    const unknown = "00000000-0000-4000-8000-000000000299";
    const arrivals = [
      `http://test-instance.drfed.org./users/${localActorId}/inbox`,
      "http://test-instance.drfed.org./inbox",
      `http://test-instance.drfed.org.:443/users/${unknown}/inbox`,
    ];
    for (const url of arrivals) {
      await send(post(JSON.stringify(activity("canonical")), url));
    }
    assert.deepEqual(
      (await findDeliveries(db)).map((delivery) => [
        delivery.inboxUrl,
        delivery.requestUrl,
      ]),
      [
        [inbox, arrivals[0]],
        [sharedInbox, arrivals[1]],
        [`${origin}/users/${unknown}/inbox`, arrivals[2]],
      ],
    );
  });
  assert.equal(
    instanceUrl(
      new URL("http://drfed.localhost:8888"),
      "a.drfed.localhost:8888",
      "/inbox",
    ).href,
    "http://a.drfed.localhost:8888/inbox",
  );
});

it("keeps IRIs that are not URLs out of URL fields, but in the request", async () => {
  await withTestHarness(async ({ db, post: query }) => {
    const auth = await seedAuthenticatedLocalInstance(db);
    await seedLocalActor(db);
    const { send } = await createRecorder(db);
    const body = JSON.stringify({
      type: "Create",
      id: "not a url",
      actor: "not an actor url",
    });
    const signature =
      'keyId="not a key",headers="(request-target)",signature="AAAA"';
    await send(post(body, inbox, { signature }));
    const result = await (
      await query(
        {
          query: `{ node(id: "${globalId("Instance", localInstanceId)}") { ... on Instance { activityDeliveries(first: 1) { edges { node {
            activityIri remoteActorIri signedKeyIri remoteHost payload rawBody requestHeaders
          } } } } } }`,
        },
        auth,
      )
    ).json();
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const { node } = result.data.node.activityDeliveries.edges[0];
    assert.deepEqual(
      [node.activityIri, node.remoteActorIri, node.signedKeyIri],
      [null, null, null],
    );
    assert.equal(node.remoteHost, null);
    assert.equal(node.payload.id, "not a url");
    assert.equal(node.payload.actor, "not an actor url");
    assert.equal(node.rawBody, body);
    assert.equal(
      new Map<string, string>(node.requestHeaders).get("signature"),
      signature,
    );
  });
});

it("orders deliveries by arrival, even when handling ends out of order", async () => {
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
      authenticatedDocumentLoaderFactory: () => () =>
        Promise.reject(new TypeError("offline")),
    });
    const { promise: reached, resolve: enter } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const recorder = createInboundRecorder({
      db,
      rootOrigin,
      federation: new Proxy(federation, {
        get(target, property) {
          if (property === "fetch") {
            return async (
              request: Request,
              options: FederationFetchOptions<unknown>,
            ) => {
              if (request.headers.has("x-slow")) {
                enter();
                await gate;
              }
              return await target.fetch(request, options);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    });
    const [slow, fast] = [activity("slow"), activity("fast")];
    const slowResponse = recorder.fetch(
      post(JSON.stringify(slow), inbox, { "x-slow": "1" }),
      fetchOptions,
    );
    await reached;
    await recorder.fetch(post(JSON.stringify(fast)), fetchOptions);
    release();
    await slowResponse;
    const iris = async (orderBy: { created: "asc" } | { id: "asc" }) =>
      (await db.query.activityDeliveries.findMany({ orderBy })).map(
        (delivery) => delivery.activityIri,
      );
    // Both the time and the ID of a delivery are chosen as its request arrives.
    assert.deepEqual(await iris({ created: "asc" }), [slow.id, fast.id]);
    assert.deepEqual(await iris({ id: "asc" }), [slow.id, fast.id]);
    const [first, second] = await db.query.activityDeliveries.findMany({
      orderBy: { created: "asc" },
    });
    assert.ok(Temporal.Instant.compare(first!.completed!, first!.created) >= 0);
    assert.ok(
      Temporal.Instant.compare(first!.completed!, second!.completed!) > 0,
    );
  });
});

it("relates a delivery to every local actor it concerns, once", async () => {
  await withTestHarness(async ({ db, post: query }) => {
    const auth = await seedAuthenticatedLocalInstance(db);
    await seedLocalActor(db);
    await seedRemoteActor(db);
    const { send } = await createRecorder(db);
    const followers = "https://remote.example.com/users/bob/followers";
    const following = "https://remote.example.com/users/bob/following";
    const featured = "https://remote.example.com/users/bob/featured";
    await addActorCollectionItem(db, remoteActorId, "followers", localActorId);
    await addActorCollectionItem(db, remoteActorId, "following", localActorId);
    const deliveries: [string, string, Record<string, unknown>][] = [
      ["own", inbox, { to: localActorIri }],
      ["shared", sharedInbox, { to: localActorIri, cc: [localActorIri] }],
      ["object", sharedInbox, { to: { id: localActorIri, type: "Person" } }],
      ["array", sharedInbox, { bcc: ["urn:other", localActorIri] }],
      ["members", sharedInbox, { cc: followers }],
      [
        "both",
        sharedInbox,
        { to: [localActorIri], cc: [following, followers] },
      ],
      ["empty", sharedInbox, { cc: featured }],
      ["public", sharedInbox, { to: "as:Public" }],
      [
        "typed",
        sharedInbox,
        { type: ["Create", "https://example.com/ns#Custom"] },
      ],
    ];
    for (const [id, url, extra] of deliveries) {
      await send(post(JSON.stringify(activity(id, extra)), url));
    }
    const rows = await findDeliveries(db);
    assert.deepEqual(
      rows.map((delivery) => [
        delivery.activityIri?.split("/").at(-1),
        delivery.actorId,
        delivery.actorLinks.map((link) => [
          link.actorId,
          link.inboxOwner,
          link.addressed,
          link.addressedDirectly,
          link.collections.map(({ collectionIri }) => collectionIri),
        ]),
      ]),
      [
        ["own", localActorId, [[localActorId, true, true, true, []]]],
        ["shared", null, [[localActorId, false, true, true, []]]],
        ["object", null, [[localActorId, false, true, true, []]]],
        ["array", null, [[localActorId, false, true, true, []]]],
        ["members", null, [[localActorId, false, true, false, [followers]]]],
        [
          "both",
          null,
          [[localActorId, false, true, true, [followers, following]]],
        ],
        ["empty", null, []],
        ["public", null, []],
        ["typed", null, []],
      ],
    );
    assert.deepEqual(rows.at(-1)?.types, [
      "Create",
      "https://example.com/ns#Custom",
    ]);
    assert.equal(rows.at(-1)?.type, "Create");
    const read = async () => {
      const result = await (
        await query(
          {
            query: `{
              actor: node(id: "${globalId("Actor", localActorId)}") { ... on Actor { activityDeliveries(first: 20) { edges { addressedDirectly viaCollections node { activityIri } } } } }
              instance: node(id: "${globalId("Instance", localInstanceId)}") { ... on Instance { activityDeliveries(first: 20) { edges { node { activityIri actor { uuid } } } } } }
            }`,
          },
          auth,
        )
      ).json();
      assert.equal(result.errors, undefined, JSON.stringify(result.errors));
      return result.data;
    };
    const names = (connection: {
      edges: { node: { activityIri: string } }[];
    }) =>
      connection.edges.map((edge) => edge.node.activityIri.split("/").at(-1));
    const before = await read();
    assert.deepEqual(names(before.actor.activityDeliveries), [
      "both",
      "members",
      "array",
      "object",
      "shared",
      "own",
    ]);
    assert.deepEqual(
      before.actor.activityDeliveries.edges
        .slice(0, 2)
        .map(
          (edge: { addressedDirectly: boolean; viaCollections: string[] }) => [
            edge.addressedDirectly,
            edge.viaCollections,
          ],
        ),
      [
        [true, [followers, following]],
        [false, [followers]],
      ],
    );
    assert.equal(
      before.instance.activityDeliveries.edges.length,
      deliveries.length,
    );
    assert.equal(
      before.instance.activityDeliveries.edges.at(-1).node.actor.uuid,
      localActorId,
    );
    await db
      .update(schema.actors)
      .set({ deleted: Temporal.Now.instant() })
      .where(eq(schema.actors.id, localActorId));
    const after = await read();
    assert.equal(after.actor, null);
    assert.equal(
      after.instance.activityDeliveries.edges.length,
      deliveries.length,
    );
    assert.equal(
      after.instance.activityDeliveries.edges.at(-1).node.actor,
      null,
    );
  });
});

it("exposes what was observed, and pages through the versions of a key", async () => {
  await withTestHarness(async ({ db, post: query }) => {
    const auth = await seedAuthenticatedLocalInstance(db);
    await seedLocalActor(db);
    const pairs = [
      await generateCryptoKeyPair(),
      await generateCryptoKeyPair(),
      await generateCryptoKeyPair(),
    ];
    const keys = new Map<string, CryptographicKey>();
    const { send } = await createRecorder(db, keys);
    const kvPrefix = httpKeyId.href;
    const body = JSON.stringify(activity("fields"));
    for (const pair of pairs) {
      keys.set(
        kvPrefix,
        new CryptographicKey({
          id: httpKeyId,
          owner: actorIri,
          publicKey: pair.publicKey,
        }),
      );
      const signed = await signRequest(post(body), pair.privateKey, httpKeyId);
      assert.equal((await send(signed)).status, 202);
    }
    const fields = `uuid status verificationMechanism verificationResult types
      rawBody rawBodyBase64 requestHeaders requestUrl inboxUrl responseBody
      recipientIris error signedKeyIri`;
    const result = await (
      await query(
        {
          query: `query($after: String) { node(id: "${globalId("Instance", localInstanceId)}") { ... on Instance { activityDeliveries(first: 1) { edges { node {
            ${fields}
            verificationKey { key { versions(first: 2, after: $after) { edges { node { uuid fingerprint } } pageInfo { hasNextPage endCursor } } } }
          } } } } } }`,
        },
        auth,
      )
    ).json();
    assert.equal(result.errors, undefined, JSON.stringify(result.errors));
    const { node } = result.data.node.activityDeliveries.edges[0];
    assert.equal(node.status, "acknowledged");
    assert.equal(node.verificationMechanism, "http_signature");
    assert.equal(node.verificationResult, "verified");
    assert.deepEqual(node.types, ["Create"]);
    assert.equal(node.rawBody, body);
    assert.equal(atob(node.rawBodyBase64), body);
    assert.ok(new Map<string, string>(node.requestHeaders).has("signature"));
    assert.equal(node.requestUrl, inbox);
    assert.equal(node.inboxUrl, inbox);
    assert.deepEqual(node.recipientIris, []);
    assert.equal(node.signedKeyIri, httpKeyId.href);
    const stored = await db.query.keyVersions.findMany({
      orderBy: { firstSeen: "asc", id: "asc" },
    });
    assert.equal(stored.length, 3);
    const firstPage = node.verificationKey.key.versions;
    assert.deepEqual(
      firstPage.edges.map((edge: { node: { uuid: string } }) => edge.node.uuid),
      stored.slice(0, 2).map((version) => version.id),
    );
    assert.equal(firstPage.pageInfo.hasNextPage, true);
    const next = await (
      await query(
        {
          query: `query($after: String) { node(id: "${Buffer.from(`Key:${stored[0]!.keyId}`).toString("base64")}") { ... on Key { versions(first: 2, after: $after) { edges { node { uuid } } pageInfo { hasNextPage } } } } }`,
          variables: { after: firstPage.pageInfo.endCursor },
        },
        auth,
      )
    ).json();
    assert.equal(next.errors, undefined, JSON.stringify(next.errors));
    assert.deepEqual(next.data.node.versions, {
      edges: [{ node: { uuid: stored[2]!.id } }],
      pageInfo: { hasNextPage: false },
    });
    const anonymous = await (
      await query({
        query: `{ node(id: "${Buffer.from(`ActivityDelivery:${node.uuid}`).toString("base64")}") { ... on ActivityDelivery { ${fields} } } }`,
      })
    ).json();
    assert.ok(anonymous.errors?.length);
    assert.equal(anonymous.data?.node ?? null, null);
  });
});

it("records a valid Linked Data signature with wrong attribution, and successful HTTP fallback", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const ld = await generateCryptoKeyPair();
    const http = await generateCryptoKeyPair();
    const bob = new URL("https://remote.example/users/bob");
    const keys = new Map([
      [
        ldKeyId.href,
        new CryptographicKey({
          id: ldKeyId,
          owner: actorIri,
          publicKey: ld.publicKey,
        }),
      ],
      [
        httpKeyId.href,
        new CryptographicKey({
          id: httpKeyId,
          owner: bob,
          publicKey: http.publicKey,
        }),
      ],
    ]);
    const loader = keyLoader(keys);
    const { contextLoader, send } = await createRecorder(db, keys, {
      documentLoader: async (url) =>
        url === bob.href
          ? {
              documentUrl: url,
              contextUrl: null,
              document: await new Person({
                id: bob,
                publicKeys: [keys.get(httpKeyId.href)!],
              }).toJsonLd(),
            }
          : await loader(url),
    });
    const signed = await signJsonLd(
      activity("wrong-ld-owner", { actor: bob.href }),
      ld.privateKey,
      ldKeyId,
      { contextLoader },
    );
    assert.equal((await send(post(JSON.stringify(signed)))).status, 401);
    const [refused] = await findDeliveries(db);
    assert.equal(refused?.verificationMechanism, "ld_signature");
    assert.equal(refused?.verificationResult, "verified");
    assert.equal(refused?.status, "rejected");
    assert.equal(refused?.verificationKey?.key.iri, ldKeyId.href);
    assert.match(refused?.error ?? "", /uncoveredAttribution/u);
    const fallback = await signRequest(
      post(JSON.stringify(signed)),
      http.privateKey,
      httpKeyId,
    );
    assert.equal((await send(fallback)).status, 202);
    const accepted = (await findDeliveries(db)).at(-1);
    assert.equal(accepted?.verificationMechanism, "http_signature");
    assert.equal(accepted?.verificationResult, "verified");
    assert.equal(accepted?.verificationKey?.key.iri, httpKeyId.href);
    assert.equal(accepted?.status, "received");
    assert.equal(accepted?.error, null);
  });
});

it("isolates completion reports for concurrent requests with different verification keys", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const first = await generateCryptoKeyPair();
    const second = await generateCryptoKeyPair();
    const { send } = await createRecorder(
      db,
      new Map([
        [
          httpKeyId.href,
          new CryptographicKey({
            id: httpKeyId,
            owner: actorIri,
            publicKey: first.publicKey,
          }),
        ],
        [
          ldKeyId.href,
          new CryptographicKey({
            id: ldKeyId,
            owner: actorIri,
            publicKey: second.publicKey,
          }),
        ],
      ]),
    );
    const requests = await Promise.all([
      signRequest(
        post(JSON.stringify(activity("parallel-first"))),
        first.privateKey,
        httpKeyId,
      ),
      signRequest(
        post(JSON.stringify(activity("parallel-second"))),
        second.privateKey,
        ldKeyId,
      ),
    ]);
    const responses = await Promise.all(requests.map(send));
    assert.deepEqual(
      responses.map((response) => response.status),
      [202, 202],
    );
    const deliveries = await findDeliveries(db);
    assert.equal(deliveries.length, 2);
    const byIri = new Map(
      deliveries.map((delivery) => [delivery.activityIri, delivery]),
    );
    assert.equal(
      byIri.get(activity("parallel-first").id)?.verificationKey?.key.iri,
      httpKeyId.href,
    );
    assert.equal(
      byIri.get(activity("parallel-second").id)?.verificationKey?.key.iri,
      ldKeyId.href,
    );
  });
});

it("records bypassed unsigned requests without claiming cryptographic verification", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const federation = await createFederation(db, {
      kv: new MemoryKvStore(),
      skipSignatureVerification: true,
    });
    const recorder = createInboundRecorder({ db, federation, rootOrigin });
    assert.equal(
      (
        await recorder.fetch(
          post(JSON.stringify(activity("bypass"))),
          fetchOptions,
        )
      ).status,
      202,
    );
    const [delivery] = await findDeliveries(db);
    assert.equal(delivery?.status, "received");
    assert.equal(delivery?.verificationResult, "no_signature");
    assert.equal(delivery?.verificationMechanism, null);
    assert.equal(delivery?.verificationKeyId, null);
  });
});

it("keeps a successfully handled delivery when recording its verification key fails", async () => {
  await withTemporaryDatabase(async (db) => {
    await seedLocalActor(db);
    const pair = await generateCryptoKeyPair();
    const { send } = await createRecorder(
      db,
      new Map([
        [
          httpKeyId.href,
          new CryptographicKey({
            id: httpKeyId,
            owner: actorIri,
            publicKey: pair.publicKey,
          }),
        ],
      ]),
    );
    await db.execute("DROP TABLE keys CASCADE");
    const request = await signRequest(
      post(JSON.stringify(activity("observation-failed"))),
      pair.privateKey,
      httpKeyId,
    );
    assert.equal((await send(request)).status, 202);
    const [delivery] = await db.query.activityDeliveries.findMany();
    assert.equal(delivery?.status, "received");
    assert.equal(delivery?.verificationResult, "unobserved");
    assert.equal(delivery?.verificationMechanism, null);
    assert.match(delivery?.error ?? "", /Verification observation failed/u);
  });
});
