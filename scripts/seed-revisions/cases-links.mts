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

// The pages that link to a resource page read legacy typed rows: the actor
// page lists objects, and the activity log links a delivery to its stored
// `Create`.  The common write stores revisions only, so these cases create
// objects as the `createObject` mutation does, and record the deliveries of
// their `Create`s directly, as no path delivers between seeded instances.
//
// Keep dependent database writes sequential.
// oxlint-disable no-await-in-loop

import {
  type JsonObject,
  type LegacyObjectInput,
  createLegacyObject,
  isLocalWriteError,
} from "@drfed/federation/local-write";
import { type Database, schema } from "@drfed/models";
import { PUBLIC_IRI } from "@drfed/models/resource";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";

import {
  type CaseContext,
  type SeedCase,
  type SeededResource,
} from "./case.mts";
import type { Workspace } from "./environment.mts";
import { loadHead } from "./writer.mts";

/** More edits than the timeline loads at once, which is 20 revisions. */
const LONG_HISTORY_EDITS = 24;
const ACCEPTED = 202;
const SERVER_ERROR = 500;

/** A legacy object with its `Create`. */
interface LegacyNote {
  readonly object: SeededResource;
  readonly create: SeededResource;
}

/** How an outbound delivery ended. */
interface Outcome {
  readonly status: "sent" | "failed";
  readonly statusCode: number;
  readonly error?: string;
}

/**
 * Reads the IRI of a resource.
 * @returns The labelled resource.
 */
async function resourceOf(
  db: Database,
  label: string,
  id: Uuid,
): Promise<SeededResource> {
  const resource = await db.query.resources.findFirst({ where: { id } });
  if (resource == null) throw new Error(`No resource ${id}.`);
  return { label, id, iri: resource.iri };
}

/**
 * Creates a public object of workspace A as the `createObject` mutation
 * does, so that it is listed on the actor page.
 * @returns The object and its `Create`.
 */
async function createLegacy(
  { db, env, alice }: CaseContext,
  label: string,
  input: Pick<LegacyObjectInput, "type" | "contentHtml" | "name">,
): Promise<LegacyNote> {
  const created = await createLegacyObject(
    env,
    { accountId: alice.member.accountId },
    {
      actorId: alice.actorId,
      summary: null,
      language: null,
      sensitive: false,
      addressing: { to: [PUBLIC_IRI] },
      ...input,
    },
  );
  if (isLocalWriteError(created)) throw new Error(JSON.stringify(created));
  if (created.activityId == null) throw new Error("Missing the Create.");
  return {
    object: await resourceOf(db, label, created.id),
    create: await resourceOf(db, `Create of the ${label}`, created.activityId),
  };
}

/**
 * Edits a legacy object's content once for each of the given versions.
 */
async function editContents(
  { writer }: CaseContext,
  objectId: Uuid,
  contents: readonly string[],
): Promise<void> {
  for (const content of contents) {
    await writer.edit(objectId, { content: `<p>${content}</p>` });
  }
}

/**
 * Reads the inbox of a workspace's actor.
 * @returns The inbox URL.
 */
async function inboxOf(db: Database, { actorId }: Workspace): Promise<string> {
  const actor = await db.query.actors.findFirst({ where: { id: actorId } });
  if (actor == null) throw new Error(`No actor ${actorId}.`);
  return actor.inboxUrl;
}

/**
 * The `Create` as DrFed delivers it: its saved document without blind
 * recipients.
 * @returns The payload.
 */
async function payloadOf(db: Database, createId: Uuid): Promise<JsonObject> {
  const {
    bto: _bto,
    bcc: _bcc,
    ...payload
  } = (await loadHead(db, createId)).document;
  return payload;
}

/**
 * Records that workspace A sent a `Create` to the actor of another
 * workspace, and, when it was sent, that the other workspace received it.
 */
async function recordDelivery(
  { db, alice }: CaseContext,
  { object, create }: LegacyNote,
  recipient: Workspace,
  outcome: Outcome,
): Promise<void> {
  const payload = await payloadOf(db, create.id);
  const inboxUrl = await inboxOf(db, recipient);
  const completed = Temporal.Now.instant();
  const common = {
    type: "Create",
    types: ["Create"],
    activityIri: create.iri,
    activityId: create.id,
    objectType: "Note",
    objectIri: object.iri,
    inboxUrl,
    requestUrl: inboxUrl,
    payload,
    completed,
  } satisfies Partial<typeof schema.activityDeliveries.$inferInsert>;
  await db.insert(schema.activityDeliveries).values({
    ...common,
    id: uuidV7(),
    instanceId: alice.instanceId,
    actorId: alice.actorId,
    direction: "outbound",
    status: outcome.status,
    statusCode: outcome.statusCode,
    error: outcome.error ?? null,
    recipientIris: [recipient.actorIri],
  });
  if (outcome.status !== "sent") return;
  await db.insert(schema.activityDeliveries).values({
    ...common,
    id: uuidV7(),
    instanceId: recipient.instanceId,
    actorId: recipient.actorId,
    direction: "inbound",
    status: "received",
    verificationMechanism: "http_signature",
    verificationResult: "verified",
    carriedSnapshot: true,
    carriedObjectSnapshot: true,
    remoteActorIri: alice.actorIri,
    remoteHost: alice.host,
    body: Buffer.from(JSON.stringify(payload)),
    statusCode: ACCEPTED,
  });
}

const listedObjects: SeedCase = async (context) => {
  const note = await createLegacy(context, "Note", {
    type: "Note",
    contentHtml: "<p>Listed, first version</p>",
    name: null,
  });
  await editContents(context, note.object.id, [
    "Listed, second version",
    "Listed, third version",
  ]);
  const article = await createLegacy(context, "Article", {
    type: "Article",
    contentHtml: "<p>An article, first version</p>",
    name: "A titled article",
  });
  await editContents(context, article.object.id, [
    "An article, second version",
  ]);
  return {
    number: 21,
    title:
      "Objects on A's actor page with Revision history links: " +
      "a Note edited twice and an Article edited once",
    resources: [note.object, article.object],
  };
};

const longHistory: SeedCase = async (context) => {
  const note = await createLegacy(context, "Note", {
    type: "Note",
    contentHtml: "<p>Version 1</p>",
    name: null,
  });
  await editContents(
    context,
    note.object.id,
    Array.from(
      { length: LONG_HISTORY_EDITS },
      (_, index) => `Version ${index + 2}`,
    ),
  );
  return {
    number: 22,
    title:
      `A Note on A's actor page edited ${LONG_HISTORY_EDITS} times, ` +
      "more than the timeline loads at once",
    resources: [note.object],
  };
};

const deliveredCreate: SeedCase = async (context) => {
  const note = await createLegacy(context, "Note", {
    type: "Note",
    contentHtml: "<p>Delivered to B</p>",
    name: null,
  });
  await recordDelivery(context, note, context.bob, {
    status: "sent",
    statusCode: ACCEPTED,
  });
  await editContents(context, note.object.id, ["Edited after delivery"]);
  return {
    number: 23,
    title:
      "A Create sent by A and received by B: Activity and Object history " +
      "links in both activity logs, the Note edited after delivery",
    resources: [note.create, note.object],
  };
};

const deletedAfterFailure: SeedCase = async (context) => {
  const note = await createLegacy(context, "Note", {
    type: "Note",
    contentHtml: "<p>Undelivered, then deleted</p>",
    name: null,
  });
  await recordDelivery(context, note, context.bob, {
    status: "failed",
    statusCode: SERVER_ERROR,
    error: "The remote inbox answered 500 Internal Server Error.",
  });
  await context.writer.remove(note.object.id);
  return {
    number: 24,
    title:
      "A Create whose delivery from A failed, then its Note deleted: " +
      "gone from A's actor page, but linked from A's activity log",
    resources: [note.create, note.object],
  };
};

/** Cases 21 to 24: the pages that link to resource pages. */
export const LINK_CASES: readonly SeedCase[] = [
  listedObjects,
  longHistory,
  deliveredCreate,
  deletedAfterFailure,
];
