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

// Keep dependent database writes sequential.
// oxlint-disable no-await-in-loop

import {
  type AddressingInput,
  type Database,
  ResourceKindConflictError,
  type Transaction,
  ensureRemoteInstance,
  ensureResource,
  lockResources,
  promoteResource,
  schema,
  storableText,
  storeAddressing,
} from "@drfed/models";
import type { ActorType, ObjectType } from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import type { InboxContext } from "@fedify/fedify";
import {
  type Object as APObject,
  type Actor,
  Application,
  Article,
  type Create,
  type DocumentLoader,
  Group,
  LanguageString,
  Note,
  Organization,
  Person,
  Service,
} from "@fedify/vocab";
import { haveSameFe34Origin } from "@fedify/vocab-runtime";
import jsonld from "@fedify/vocab-runtime/jsonld";
import { getLogger } from "@logtape/logtape";

import type { Receipt } from "./activity-delivery/tracking.ts";
import { canonicalizeAuthority } from "./origin.ts";

const logger = getLogger(["drfed", "federation"]);

/** A `Create` that passed every rule, with what storing it needs. */
interface Accepted {
  readonly activityIri: string;
  readonly activity: Create;
  readonly actorIri: string;
  readonly actor: Actor;
  readonly actorType: ActorType;
  readonly inboxUrl: string;
  readonly objectIri: string;
  readonly object: APObject;
  readonly objectType: ObjectType;
  readonly contentHtml: string;
  readonly name: string | null;
  readonly summary: string | null;
  readonly username: string | null;
  /** The object as received, or as fetched when only its IRI was. */
  readonly objectDocument: unknown;
  readonly receipt: Receipt;
}

/** Why a `Create` is not stored. */
class Refusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "Refusal";
  }
}

const actorTypes: readonly (readonly [
  abstract new (...args: never[]) => Actor,
  ActorType,
])[] = [
  [Application, "Application"],
  [Group, "Group"],
  [Organization, "Organization"],
  [Person, "Person"],
  [Service, "Service"],
];

const objectTypes: readonly (readonly [
  abstract new (...args: never[]) => APObject,
  ObjectType,
])[] = [
  [Article, "Article"],
  [Note, "Note"],
];

const typeOf = <Instance, Name>(
  types: readonly (readonly [
    abstract new (...args: never[]) => Instance,
    Name,
  ])[],
  value: unknown,
): Name | undefined => types.find(([type]) => value instanceof type)?.[1];

/**
 * The addressing an activity or object declares, by IRI.
 * @returns The addressing to store.
 */
const addressingOf = (source: APObject): AddressingInput => ({
  to: source.toIds.map((iri) => iri.href),
  cc: source.ccIds.map((iri) => iri.href),
  bto: source.btoIds.map((iri) => iri.href),
  bcc: source.bccIds.map((iri) => iri.href),
  audience: source.audienceIds.map((iri) => iri.href),
});

const addressedIris = (input: AddressingInput): string[] =>
  Object.values(input).flatMap((iris) => iris ?? []);

/**
 * The canonical tag of the first language the content is given in, if it
 * fits the column.
 * @returns The BCP 47 tag, or null.
 */
function languageOf(object: APObject): string | null {
  const tagged = object.contents.find(
    (content) => content instanceof LanguageString,
  );
  if (!(tagged instanceof LanguageString)) return null;
  try {
    const [tag] = Intl.getCanonicalLocales(tagged.locale.toString());
    return tag != null && tag.length <= 35 ? tag : null;
  } catch {
    return null;
  }
}

const AS_OBJECT = "https://www.w3.org/ns/activitystreams#object";
const PROBE = "urn:drfed:embedded-object";
/**
 * How many places of a document are tried for its object, each by expanding
 * it again, so that a sender cannot make DrFed expand a large document over
 * and over.
 */
const MAX_PROBES = 64;

type Path = readonly (string | number)[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value != null && !Array.isArray(value);

/**
 * Every JSON object in a document, shallowest first, but those of contexts.
 * @returns Their paths.
 */
function objectPaths(document: unknown): Path[] {
  const paths: Path[] = [];
  let level: { readonly value: unknown; readonly path: Path }[] = [
    { value: document, path: [] },
  ];
  while (level.length > 0) {
    paths.push(
      ...level.filter(({ value }) => isRecord(value)).map(({ path }) => path),
    );
    level = level.flatMap(({ value, path }) =>
      Array.isArray(value)
        ? value.map((item, index) => ({ value: item, path: [...path, index] }))
        : isRecord(value)
          ? Object.entries(value)
              .filter(([key]) => key !== "@context")
              .map(([key, item]) => ({ value: item, path: [...path, key] }))
          : [],
    );
  }
  return paths;
}

const valueAt = (document: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      Array.isArray(value) || isRecord(value)
        ? (value as Record<string | number, unknown>)[key]
        : undefined,
    document,
  );

const replaceAt = (document: unknown, path: Path, value: unknown): unknown => {
  const [key, ...rest] = path;
  if (key == null) return value;
  if (Array.isArray(document)) {
    return document.map((item, index) =>
      index === key ? replaceAt(item, rest, value) : item,
    );
  }
  return isRecord(document)
    ? { ...document, [key]: replaceAt(document[key], rest, value) }
    : document;
};

/**
 * Whether the JSON object at a path is what Fedify reads as the object of
 * the activity: the first `as:object` of the first expanded node, under
 * whatever terms, aliases, graphs or containers the document uses.
 * @returns Whether a node in its place becomes the activity's object.
 */
async function isObjectAt(
  payload: unknown,
  path: Path,
  contextLoader: DocumentLoader,
): Promise<boolean> {
  try {
    const [activity] = await jsonld.expand(
      replaceAt(payload, path, { "@id": PROBE }) as Record<string, unknown>,
      { documentLoader: contextLoader, keepFreeFloatingNodes: true },
    );
    const objects = isRecord(activity) ? activity[AS_OBJECT] : undefined;
    const [first] = Array.isArray(objects) ? objects : [];
    return isRecord(first) && first["@id"] === PROBE;
  } catch {
    return false;
  }
}

/**
 * The object of a received activity, as it was received.
 * @returns The embedded object, or undefined when it is not found.
 */
async function embeddedObject(
  payload: unknown,
  contextLoader: DocumentLoader,
): Promise<unknown> {
  // The document itself is the activity, never its object.
  const paths = objectPaths(payload).filter((path) => path.length > 0);
  for (const path of paths.slice(0, MAX_PROBES)) {
    if (await isObjectAt(payload, path, contextLoader)) {
      return valueAt(payload, path);
    }
  }
  logger.warn("Could not find the object of an activity as received.");
  return undefined;
}

const textOf = (value: string | LanguageString | null): string | null =>
  value?.toString() ?? null;

/**
 * Refuse members whose text a text column would refuse or alter; the delivery
 * keeps them as received.
 * @throws {Refusal} When one of them is such text.
 */
function checkStorable(texts: Readonly<Record<string, string | null>>): void {
  const member = Object.entries(texts).find(
    ([, value]) => value != null && !storableText(value),
  )?.[0];
  if (member != null) {
    throw new Refusal(`its ${member} holds text that cannot be stored as is`);
  }
}

/**
 * Dereference the object of a `Create`, noting whether it had to be fetched.
 * Fedify fetches an embedded object unless its origin vouches for it.
 * @returns The object and its document, or a refusal.
 * @throws {Refusal} When the object cannot be had.
 */
async function loadObject(
  ctx: InboxContext<unknown>,
  activity: Create,
  receipt: Receipt,
): Promise<{ readonly object: APObject; readonly document: unknown }> {
  const objectIri = activity.objectId?.href;
  let fetched = false;
  const documentLoader: DocumentLoader = async (url, options) => {
    if (url === objectIri) fetched = true;
    return await ctx.documentLoader(url, options);
  };
  let object: APObject | null;
  try {
    object = await activity.getObject({
      documentLoader,
      contextLoader: ctx.contextLoader,
    });
  } catch (error) {
    throw new Refusal(`its object could not be fetched: ${String(error)}`);
  }
  if (object == null) throw new Refusal("it has no object");
  return {
    object,
    document: fetched
      ? await object.toJsonLd({ contextLoader: ctx.contextLoader })
      : await embeddedObject(receipt.payload, ctx.contextLoader),
  };
}

/**
 * Dereference the actor of a `Create`, which Fedify has already fetched to
 * authenticate it.
 * @returns The actor.
 * @throws {Refusal} When the actor cannot be had.
 */
async function loadActor(
  ctx: InboxContext<unknown>,
  activity: Create,
  actorIri: string,
): Promise<Actor> {
  let actor: Actor | null;
  try {
    actor = await activity.getActor({
      documentLoader: ctx.documentLoader,
      contextLoader: ctx.contextLoader,
    });
  } catch (error) {
    throw new Refusal(`its actor could not be fetched: ${String(error)}`);
  }
  if (actor?.id?.href !== actorIri) {
    throw new Refusal("its actor could not be fetched");
  }
  return actor;
}

/**
 * Check a received `Create` against the rules for storing it: Fedify has
 * authenticated its actor, and FEP-fe34 makes that actor the owner of the
 * object it creates.
 * @returns What storing it needs.
 * @throws {Refusal} When a rule is not met.
 */
async function accept(
  ctx: InboxContext<unknown>,
  activity: Create,
  actorIri: string,
  receipt: Receipt,
): Promise<Accepted> {
  const activityIri = activity.id?.href;
  if (activityIri == null) throw new Refusal("it has no ID");
  const { object, document } = await loadObject(ctx, activity, receipt);
  const objectIri = object.id?.href;
  const objectType = typeOf(objectTypes, object);
  if (objectType == null) throw new Refusal("its object is not supported");
  if (objectIri == null) throw new Refusal("its object has no ID");
  if (!object.attributionIds.some((iri) => iri.href === actorIri)) {
    throw new Refusal("its object is not attributed to its actor");
  }
  if (!haveSameFe34Origin(objectIri, actorIri)) {
    throw new Refusal("its object is not on the origin of its actor");
  }
  const contentHtml = textOf(object.content);
  if (contentHtml == null || contentHtml.trim() === "") {
    throw new Refusal("its object has no content");
  }
  const name = textOf(object.name);
  const summary = textOf(object.summary);
  checkStorable({
    "object's content": contentHtml,
    "object's name": name,
    "object's summary": summary,
  });
  const actor = await loadActor(ctx, activity, actorIri);
  const actorType = typeOf(actorTypes, actor);
  if (actorType == null) throw new Refusal("its actor is not supported");
  if (actor.inboxId == null) throw new Refusal("its actor has no inbox");
  const username = textOf(actor.preferredUsername);
  checkStorable({ "actor's preferredUsername": username });
  return {
    activityIri,
    activity,
    actorIri,
    actor,
    actorType,
    inboxUrl: actor.inboxId.href,
    objectIri,
    object,
    objectType,
    contentHtml,
    name,
    summary,
    username,
    objectDocument: document,
    receipt,
  };
}

/**
 * Store an accepted `Create` with its actor and object.  An IRI that is
 * already stored as the same kind is reused as it is, so a `Create` received
 * again, or by several instances at once, is stored once.  Nothing is written
 * for an activity already stored, even if it names another actor or object
 * this time.
 * @throws {Refusal} When its actor's host is a local instance's, its object
 *                   is already another actor's, or it is already stored.
 * @throws {ResourceKindConflictError} When an IRI is another kind of resource.
 */
async function store(db: Database, accepted: Accepted): Promise<void> {
  const { activity, actor, object, receipt } = accepted;
  const objectAddressing = addressingOf(object);
  const activityAddressing = addressingOf(activity);
  await db.transaction(async (tx) => {
    const instance = await ensureRemoteInstance(
      tx,
      canonicalizeAuthority(new URL(accepted.actorIri).host),
    );
    if (instance == null) {
      throw new Refusal("its actor is on a local instance");
    }
    // Wait for new IRIs in the same order in every transaction.
    const iris = new Set([
      accepted.actorIri,
      accepted.objectIri,
      accepted.activityIri,
      ...addressedIris(objectAddressing),
      ...addressedIris(activityAddressing),
    ]);
    for (const iri of [...iris].toSorted()) await ensureResource(tx, iri);
    // Then lock what is promoted below, in the same order everywhere too.
    await lockResources(tx, [
      accepted.actorIri,
      accepted.objectIri,
      accepted.activityIri,
    ]);
    const actorId = await promoteResource(
      tx,
      accepted.actorIri,
      "actor",
      async (inner, resource) => {
        await inner.insert(schema.actors).values({
          id: resource.id,
          type: accepted.actorType,
          username: accepted.username,
          instanceId: instance.id,
          inboxUrl: accepted.inboxUrl,
          document: await actor.toJsonLd(),
        });
        return resource.id;
      },
      undefined,
      (_inner, resource) => Promise.resolve(resource.id),
    );
    const stored = await promoteResource(
      tx,
      accepted.objectIri,
      "object",
      async (inner, resource) => {
        const [row] = await inner
          .insert(schema.objects)
          .values({
            id: resource.id,
            actorId,
            type: accepted.objectType,
            document: accepted.objectDocument,
            name: accepted.name,
            summary: accepted.summary,
            contentHtml: accepted.contentHtml,
            language: languageOf(object),
            sensitive: object.sensitive ?? false,
            published: object.published ?? receipt.received,
          })
          .returning({
            id: schema.objects.id,
            published: schema.objects.published,
          });
        if (row == null) throw new Error("Object insertion returned no row.");
        await storeAddressing(inner, row.id, objectAddressing);
        return row;
      },
      undefined,
      async (inner, resource) => await reuseObject(inner, resource.id, actorId),
    );
    await promoteResource(
      tx,
      accepted.activityIri,
      "activity",
      async (inner, resource) => {
        await inner.insert(schema.activities).values({
          id: resource.id,
          type: "Create",
          actorId,
          objectId: stored.id,
          published: activity.published ?? stored.published,
          // The activity as its origin sent it, not as Fedify serializes it.
          document: receipt.payload,
        });
        await storeAddressing(inner, resource.id, activityAddressing);
      },
      undefined,
      // The activity is stored as it was first received; nothing this
      // transaction wrote before finding it is kept.
      () => Promise.reject(new Refusal("it is already stored")),
    );
  });
}

/**
 * An object stored before, which a `Create` of its own actor may refer to.
 * @returns Its ID and publication time.
 * @throws {Refusal} When it is another actor's.
 */
async function reuseObject(
  tx: Transaction,
  id: Uuid,
  actorId: Uuid,
): Promise<{ readonly id: Uuid; readonly published: Temporal.Instant }> {
  const row = await tx.query.objects.findFirst({
    columns: { id: true, actorId: true, published: true },
    where: { id },
  });
  if (row == null) throw new Error(`Object ${id} has no row.`);
  if (row.actorId !== actorId) {
    throw new Refusal("its object is already another actor's");
  }
  return row;
}

/**
 * Whether an actor is a local actor, whose activities DrFed has signed and
 * stored itself.
 * @returns Whether the IRI is a local actor's.
 */
async function isLocalActor(db: Database, actorIri: string): Promise<boolean> {
  const actor = await db.query.actors.findFirst({
    columns: { id: true },
    where: { localId: { isNotNull: true }, resource: { iri: actorIri } },
  });
  return actor != null;
}

/**
 * Store a `Create` an inbox received, if it meets the rules for storing it.
 * One that does not is logged and left out; the delivery keeps it as received
 * either way.  A database error is thrown, so that Fedify retries a queued one.
 * @param receipt What the request carried, without which nothing is stored.
 */
export async function persistCreate(
  db: Database,
  ctx: InboxContext<unknown>,
  activity: Create,
  receipt: Receipt | undefined,
): Promise<void> {
  const activityIri = activity.id?.href;
  const actorIri = activity.actorId?.href;
  try {
    if (actorIri == null) throw new Refusal("it has no actor");
    // Its delivery is linked to the activity its sender stored.
    if (await isLocalActor(db, actorIri)) return;
    if (receipt == null) throw new Refusal("its arrival was not recorded");
    await store(db, await accept(ctx, activity, actorIri, receipt));
  } catch (error) {
    if (
      !(error instanceof Refusal || error instanceof ResourceKindConflictError)
    ) {
      throw error;
    }
    logger.info("Not storing the Create {activityIri}, as {reason}.", {
      activityIri,
      reason: error.message,
    });
  }
}
