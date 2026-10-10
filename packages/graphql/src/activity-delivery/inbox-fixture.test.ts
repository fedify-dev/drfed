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

// Fixtures for inbox requests from actors whose documents are served offline.
// oxlint-disable no-await-in-loop

import { setTimeout as sleep } from "node:timers/promises";

import createFederation, {
  type TrackedFederation,
  createInboundRecorder,
} from "@drfed/federation";
import { type Database, schema } from "@drfed/models";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";
import {
  MemoryKvStore,
  type MessageQueue,
  generateCryptoKeyPair,
  signRequest,
} from "@fedify/fedify";
import { CryptographicKey, type DocumentLoader, Person } from "@fedify/vocab";

import { hashSecret } from "../auth/hash.ts";
import { created, expires } from "../seed.test.ts";

export const PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
export const rootOrigin = new URL("https://drfed.org");
/** The host of the instance `seedLocalInstance()` seeds. */
export const hostA = "test-instance.drfed.org";
export const hostB = "other-instance.drfed.org";
export const otherInstanceId: Uuid = "00000000-0000-4000-8000-000000000103";
export const hostC = "third-instance.drfed.org";
export const thirdInstanceId: Uuid = "00000000-0000-4000-8000-000000000104";

/** Documents served by IRI, as remote servers would. */
export type Documents = Map<string, unknown>;

/** An actor whose key signs requests. */
export interface Signer {
  readonly iri: string;
  readonly keyId: URL;
  readonly privateKey: CryptoKey;
}

/**
 * Serve an actor and its key.
 * @returns What signs the actor's requests.
 */
export async function addActor(
  documents: Documents,
  iri: string,
  {
    preferredUsername,
    inbox = true,
  }: { readonly preferredUsername?: string; readonly inbox?: boolean } = {},
): Promise<Signer> {
  const pair = await generateCryptoKeyPair();
  const keyId = new URL(`${iri}#main-key`);
  const key = new CryptographicKey({
    id: keyId,
    owner: new URL(iri),
    publicKey: pair.publicKey,
  });
  const actor = new Person({
    id: new URL(iri),
    preferredUsername: preferredUsername ?? null,
    inbox: inbox ? new URL(`${iri}/inbox`) : null,
    publicKey: key,
  });
  documents.set(iri, await actor.toJsonLd());
  documents.set(keyId.href, await key.toJsonLd());
  return { iri, keyId, privateKey: pair.privateKey };
}

const loaderOf =
  (documents: Documents): DocumentLoader =>
  (url) => {
    const document = documents.get(url);
    return document === undefined
      ? Promise.reject(new TypeError(`offline: ${url}`))
      : Promise.resolve({ documentUrl: url, contextUrl: null, document });
  };

/**
 * Record inbox requests with a federation that fetches only the documents.
 * @returns The federation, and how to send a request through the recorder.
 */
export async function createRecorder(
  db: Database,
  documents: Documents,
  { queue }: { readonly queue?: MessageQueue } = {},
): Promise<{
  readonly federation: TrackedFederation;
  send(request: Request): Promise<Response>;
}> {
  const kv = new MemoryKvStore();
  const { contextLoader } = (await createFederation(db, { kv })).createContext(
    new URL(`https://${hostA}/`),
    undefined,
  );
  const documentLoader = loaderOf(documents);
  const federation = await createFederation(db, {
    kv,
    contextLoaderFactory: () => contextLoader,
    documentLoaderFactory: () => documentLoader,
    authenticatedDocumentLoaderFactory: () => documentLoader,
    ...(queue == null ? {} : { queue, manuallyStartQueue: true }),
  });
  const recorder = createInboundRecorder({ db, federation, rootOrigin });
  return {
    federation,
    send: (request) => recorder.fetch(request, { contextData: undefined }),
  };
}

/**
 * Run with the federation's queue workers started.
 * @returns What the run returns.
 */
export async function withWorkers<T>(
  federation: TrackedFederation,
  run: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const running = federation.startQueue(undefined, {
    signal: controller.signal,
  });
  try {
    return await run();
  } finally {
    controller.abort();
    await running;
  }
}

/** @returns An unsigned POST of the body to a shared inbox. */
export const post = (body: unknown, host = hostA): Request =>
  new Request(`https://${host}/inbox`, {
    method: "POST",
    headers: { "content-type": "application/activity+json" },
    body: JSON.stringify(body),
  });

/** @returns A POST of the body to a shared inbox, signed by the signer. */
export const signed = (
  signer: Signer,
  body: unknown,
  host = hostA,
): Promise<Request> =>
  signRequest(post(body, host), signer.privateKey, signer.keyId);

/**
 * A `Create` of a `Note`, both on the actor's origin and addressed to the
 * public and the actor's followers.
 * @returns The JSON body.
 */
export const createOf = (
  actor: string,
  name: string,
  {
    activity = {},
    object = {},
  }: {
    readonly activity?: Record<string, unknown>;
    readonly object?: Record<string, unknown> | string;
  } = {},
): Record<string, unknown> => {
  const { origin } = new URL(actor);
  const addressing = { to: [PUBLIC], cc: [`${actor}/followers`] };
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${origin}/activities/${name}`,
    type: "Create",
    actor,
    ...addressing,
    object:
      typeof object === "string"
        ? object
        : {
            id: `${origin}/notes/${name}`,
            type: "Note",
            attributedTo: actor,
            content: `<p>${name}</p>`,
            published: "2026-10-01T00:00:00Z",
            ...addressing,
            ...object,
          },
    ...activity,
  };
};

/**
 * Read until the value is done, as a queue worker settles it.
 * @returns The last value read.
 */
export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
): Promise<T> {
  for (let tries = 0; ; tries += 1) {
    const value = await read();
    if (done(value) || tries >= 300) return value;
    await sleep(10);
  }
}

/** @returns Every delivery, in arrival order. */
export const findDeliveries = (db: Database) =>
  db.query.activityDeliveries.findMany({
    orderBy: { created: "asc", id: "asc" },
  });

/** Seed another local instance, by default the one at {@link hostB}. */
export async function seedOtherInstance(
  db: Database,
  {
    id = otherInstanceId,
    slug = "other-instance",
    host = hostB,
  }: {
    readonly id?: Uuid;
    readonly slug?: string;
    readonly host?: string;
  } = {},
): Promise<void> {
  await db.insert(schema.localInstances).values({ id, slug, expires });
  await db.insert(schema.instances).values({ id, localId: id, host, created });
}

/**
 * Seed an account with a session, and its membership if any.
 * @returns The request options that authenticate as it.
 */
export async function seedAccount(
  db: Database,
  name: string,
  {
    admin = false,
    member,
  }: {
    readonly admin?: boolean;
    readonly member?: {
      readonly instanceId: Uuid;
      readonly accepted: Temporal.Instant | null;
    };
  } = {},
): Promise<RequestInit> {
  const id = uuidV7();
  const token = `token-${name}`;
  await db.insert(schema.accounts).values({
    id,
    email: `${name}@example.com`,
    name,
    admin,
    created,
  });
  await db.insert(schema.sessions).values({
    id: uuidV7(),
    accountId: id,
    tokenHash: await hashSecret(token),
  });
  if (member != null) {
    await db.insert(schema.instanceMembers).values({
      accountId: id,
      instanceId: member.instanceId,
      admin: false,
      accepted: member.accepted,
      created,
    });
  }
  return { headers: { authorization: `Bearer ${token}` } };
}

/** @returns The Relay global ID of an activity delivery. */
export const deliveryGlobalId = (id: string): string =>
  Buffer.from(`ActivityDelivery:${id}`).toString("base64");
