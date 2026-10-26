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

import { isDeepStrictEqual } from "node:util";

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database, Transaction } from "./db.ts";
import {
  type ActivityDelivery,
  type NewActivityDelivery,
  type NewActivityDeliveryActor,
  activities,
  activityDeliveries,
  activityDeliveryActorCollections,
  activityDeliveryActors,
  activityDeliveryAttempts,
  actors,
  objects,
  resourceRevisions,
  resources,
  revisionReceipts,
} from "./schema.ts";
import { storableText } from "./text.ts";
import { type Uuid, uuidV7 } from "./uuid.ts";

/** The marks of what a delivery carried are the model's to decide. */
type DeliveryEntry = Omit<
  NewActivityDelivery,
  "id" | "direction" | "status" | "carriedSnapshot" | "carriedObjectSnapshot"
>;

export interface AddressedActor {
  readonly actorId: Uuid;
  readonly viaCollectionIri?: string | null;
}

/**
 * `payload` is `undefined` for an unparsable body and `null` for JSON `null`;
 * it is stored as SQL `NULL` when jsonb cannot hold it, and `body` keeps it.
 * `fetchedObject` is stored as SQL `NULL` when jsonb cannot hold it too.
 * An inbound delivery is linked to its activity only by
 * `linkInboundActivity()`.
 */
export type InboundDeliveryEntry = Omit<
  DeliveryEntry,
  "body" | "verificationResult" | "recipientIris" | "activityId"
> & {
  /**
   * Chosen in advance when something must name the delivery before it exists.
   */
  readonly id?: Uuid;
  readonly status: "received" | "acknowledged" | "unverified" | "rejected";
  readonly verificationResult: NonNullable<DeliveryEntry["verificationResult"]>;
  readonly body: Uint8Array;
  readonly addressed?: readonly AddressedActor[];
  /** When the request arrived, before verification and handling. */
  readonly created: Temporal.Instant;
  /** When DrFed answered the request. */
  readonly completed: Temporal.Instant;
};

/** `payload` is the document before signing, without `bto` and `bcc`. */
export type OutboundDeliveryEntry = Omit<
  DeliveryEntry,
  | "verificationKeyId"
  | "verificationMechanism"
  | "verificationResult"
  | "body"
  | "headers"
  | "requestUrl"
  | "completed"
  | "fetchedObject"
> & {
  readonly activityIri: string;
};

type ActorRow = Omit<NewActivityDeliveryActor, "deliveryId" | "created"> & {
  /** The addressed collections that reached the actor, sorted. */
  readonly collectionIris?: readonly string[];
};

/**
 * Merge the inbox owner and addressed actors into one row per actor, keeping
 * every way each was addressed, whatever order they come in.
 * @returns The actor rows of an inbound delivery.
 */
export function inboundActorRows(entry: {
  readonly actorId?: Uuid | null | undefined;
  readonly addressed?: readonly AddressedActor[] | undefined;
}): ActorRow[] {
  const rows = new Map<Uuid, ActorRow>();
  if (entry.actorId != null) {
    rows.set(entry.actorId, { actorId: entry.actorId, inboxOwner: true });
  }
  for (const { actorId, viaCollectionIri } of entry.addressed ?? []) {
    const row = rows.get(actorId);
    const collectionIris = row?.collectionIris ?? [];
    rows.set(actorId, {
      ...row,
      actorId,
      addressed: true,
      addressedDirectly:
        row?.addressedDirectly === true || viaCollectionIri == null,
      collectionIris:
        viaCollectionIri == null
          ? collectionIris
          : [...new Set([...collectionIris, viaCollectionIri])].toSorted(),
    });
  }
  return [...rows.values()];
}

/**
 * PostgreSQL's jsonb holds neither U+0000 nor an unpaired surrogate, in keys
 * or in values.
 * @returns Whether the JSON value can be stored as jsonb.
 */
function storableJson(value: unknown): boolean {
  if (typeof value === "string") return storableText(value);
  return (
    typeof value !== "object" ||
    value == null ||
    Object.entries(value).every(
      ([key, item]) => storableJson(key) && storableJson(item),
    )
  );
}

/**
 * Keep a payload jsonb cannot hold out of the delivery, rather than the
 * delivery.
 * @returns The value to store, SQL `NULL` for such a payload.
 */
const jsonb = (payload: unknown) =>
  payload === null
    ? sql`'null'::jsonb`
    : storableJson(payload)
      ? payload
      : null;

/**
 * A fetched object is a JSON object, so nothing fetched is SQL `NULL`.
 * @returns The value to store.
 */
const storedObject = (document: unknown) =>
  document == null ? null : jsonb(document);

/**
 * PostgreSQL's text holds no U+0000, which a remote response or an error
 * quoting one may carry; keep the rest of it rather than lose the delivery.
 * @returns The text with each U+0000 replaced by U+FFFD.
 */
const text = (value: string | null | undefined): string | null =>
  value?.replaceAll("\0", "\ufffd") ?? null;

/**
 * Refuse to relate a delivery to anything but local actors of its instance,
 * which neither foreign key can tell.
 * @throws {Error} When an actor is remote, or of another instance.
 */
async function checkLocalActors(
  tx: Transaction,
  instanceId: Uuid,
  actorIds: readonly (Uuid | null | undefined)[],
): Promise<void> {
  const ids = [...new Set(actorIds.filter((id) => id != null))];
  if (ids.length === 0) return;
  const local = await tx.$count(
    actors,
    and(
      inArray(actors.id, ids),
      eq(actors.instanceId, instanceId),
      isNotNull(actors.localId),
    ),
  );
  if (local !== ids.length) {
    throw new Error(
      "An activity delivery relates only to local actors of its instance.",
    );
  }
}

async function insertDelivery(
  db: Database,
  delivery: NewActivityDelivery,
  links: readonly ActorRow[],
): Promise<ActivityDelivery> {
  return await db.transaction(async (tx) => {
    await checkLocalActors(tx, delivery.instanceId, [
      delivery.actorId,
      ...links.map(({ actorId }) => actorId),
    ]);
    const [row] = await tx
      .insert(activityDeliveries)
      .values({
        ...delivery,
        error: text(delivery.error),
        responseBody: text(delivery.responseBody),
      })
      .returning();
    if (row == null) {
      throw new Error("Missing activity delivery after insertion.");
    }
    if (links.length > 0) {
      await tx.insert(activityDeliveryActors).values(
        links.map(({ collectionIris: _, ...link }) => ({
          ...link,
          deliveryId: row.id,
          created: row.created,
        })),
      );
    }
    const collections = links.flatMap(({ actorId, collectionIris = [] }) =>
      collectionIris.map((collectionIri) => ({
        deliveryId: row.id,
        actorId,
        collectionIri,
      })),
    );
    if (collections.length > 0) {
      await tx.insert(activityDeliveryActorCollections).values(collections);
    }
    return row;
  });
}

/**
 * Persist one inbound observation with its actor rows in one transaction.
 * The inbox owner and every addressed actor must be local actors of
 * `instanceId`; otherwise nothing is recorded.
 * @returns The inserted inbound delivery.
 * @throws {Error} When an actor is not a local actor of the instance.
 */
export async function recordInbound(
  db: Database,
  { addressed, body, id = uuidV7(), ...entry }: InboundDeliveryEntry,
): Promise<ActivityDelivery> {
  return await insertDelivery(
    db,
    {
      ...entry,
      body: Buffer.from(body),
      payload: jsonb(entry.payload),
      fetchedObject: storedObject(entry.fetchedObject),
      id,
      direction: "inbound",
      // Whatever a caller outside TypeScript passes.
      carriedSnapshot: false,
      carriedObjectSnapshot: false,
    },
    inboundActorRows({ actorId: entry.actorId, addressed }),
  );
}

/**
 * Record that an inbox listener ran for an inbound delivery answered before it
 * did, as a queued one is.
 * @returns Whether an acknowledged inbound delivery was found.
 */
export async function receiveInbound(db: Database, id: Uuid): Promise<boolean> {
  const rows = await db
    .update(activityDeliveries)
    .set({ status: "received" })
    .where(
      and(
        eq(activityDeliveries.id, id),
        eq(activityDeliveries.direction, "inbound"),
        eq(activityDeliveries.status, "acknowledged"),
      ),
    )
    .returning({ id: activityDeliveries.id });
  return rows.length > 0;
}

/**
 * Decide what a linked inbound delivery carried, anew every time, so that a
 * mark left from an activity deleted since never carries over to another
 * stored under the same IRI:
 *
 *  -  The stored activity, when its payload is the stored document, since the
 *     same IRI may arrive again with other contents.
 *  -  The object stored with that activity, when the delivery carried the
 *     activity and the object was taken from it, or when its inbox listener
 *     fetched the object as stored.  Matching the activity proves nothing of
 *     an object fetched apart from it, which may differ from fetch to fetch.
 *
 * A payload or a fetched object jsonb could not hold is stored as SQL `NULL`
 * and carries nothing.  An unlinked delivery is left as is.
 */
async function decideCarried(tx: Transaction, deliveryId: Uuid): Promise<void> {
  // Both current callers already update this delivery; retain that lock order
  // explicitly so every recomputation serializes evidence and receipt changes.
  const [delivery] = await tx
    .select({
      activityId: activityDeliveries.activityId,
      payload: activityDeliveries.payload,
      fetchedObject: activityDeliveries.fetchedObject,
    })
    .from(activityDeliveries)
    .where(
      and(
        eq(activityDeliveries.id, deliveryId),
        eq(activityDeliveries.direction, "inbound"),
      ),
    )
    .for("update");
  if (delivery === undefined) return;
  const [activity] =
    delivery.activityId === null
      ? []
      : await tx
          .select({
            id: activities.id,
            document: activities.document,
          })
          .from(activities)
          .where(eq(activities.id, delivery.activityId));
  // Lock separately, never the nullable side of an outer join. Deletion waits
  // for this transaction, then its AFTER DELETE cleanup sees our receipts.
  // This must precede receipt writes to avoid reversing the delete lock order.
  const [object] =
    activity === undefined
      ? []
      : await tx
          .select({
            id: objects.id,
            document: objects.document,
            fetched: objects.fetched,
          })
          .from(objects)
          .where(eq(objects.activityId, activity.id))
          .for("key share");
  await tx
    .delete(revisionReceipts)
    .where(eq(revisionReceipts.deliveryId, deliveryId));
  if (activity === undefined) return;
  const carriedSnapshot =
    delivery.payload != null &&
    isDeepStrictEqual(delivery.payload, activity.document);
  const carriedObjectSnapshot =
    carriedSnapshot &&
    object !== undefined &&
    (!object.fetched ||
      (delivery.fetchedObject != null &&
        isDeepStrictEqual(delivery.fetchedObject, object.document)));
  await tx
    .update(activityDeliveries)
    .set({ carriedSnapshot, carriedObjectSnapshot })
    .where(eq(activityDeliveries.id, deliveryId));
  if (!carriedSnapshot) return;
  const revisions = await tx
    .select()
    .from(resourceRevisions)
    .where(
      and(
        inArray(
          resourceRevisions.resourceId,
          object === undefined ? [activity.id] : [activity.id, object.id],
        ),
        eq(resourceRevisions.sequence, 1),
        eq(resourceRevisions.kind, "snapshot"),
      ),
    );
  const activityRevision = revisions.find(
    (revision) => revision.resourceId === activity.id,
  );
  if (
    activityRevision === undefined ||
    !isDeepStrictEqual(activityRevision.document, activity.document)
  ) {
    return;
  }
  const receipts: (typeof revisionReceipts.$inferInsert)[] = [
    {
      deliveryId,
      revisionId: activityRevision.id,
      role: "activity",
    },
  ];
  const objectRevision =
    object === undefined
      ? undefined
      : revisions.find((revision) => revision.resourceId === object.id);
  if (
    carriedObjectSnapshot &&
    object !== undefined &&
    objectRevision !== undefined &&
    isDeepStrictEqual(objectRevision.document, object.document)
  ) {
    receipts.push({
      deliveryId,
      revisionId: objectRevision.id,
      role: "object",
    });
  }
  await tx.insert(revisionReceipts).values(receipts);
}

/**
 * Link an inbound delivery to the stored activity its activity IRI names.
 * Only a delivery Fedify verified and answered with 2xx is linked: Fedify
 * authenticates an activity before accepting it, so its actor has the origin
 * of the activity's ID, whether an inbox listener ran or it was a duplicate.
 * A delivery that is already linked is left as is.
 *
 * The link names the activity whatever the delivery carried; what it carried
 * is decided as the link is made, as `recordFetchedObject()` decides it again.
 * @returns Whether the delivery was linked.
 */
export async function linkInboundActivity(
  db: Database | Transaction,
  deliveryId: Uuid,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .update(activityDeliveries)
      .set({ activityId: resources.id })
      .from(resources)
      .innerJoin(activities, eq(activities.id, resources.id))
      .where(
        and(
          eq(activityDeliveries.id, deliveryId),
          eq(activityDeliveries.direction, "inbound"),
          inArray(activityDeliveries.status, ["received", "acknowledged"]),
          eq(activityDeliveries.verificationResult, "verified"),
          isNull(activityDeliveries.activityId),
          eq(resources.iri, activityDeliveries.activityIri),
          eq(resources.kind, "activity"),
        ),
      )
      .returning({ id: activityDeliveries.id });
    if (row == null) return false;
    await decideCarried(tx, deliveryId);
    return true;
  });
}

/**
 * Record the object an inbound delivery's inbox listener fetched from its IRI,
 * and decide again what the delivery carried if it is linked already, as a
 * duplicate queued for a worker is before its listener runs.
 * @returns Whether the inbound delivery was found.
 */
export async function recordFetchedObject(
  db: Database,
  deliveryId: Uuid,
  document: unknown,
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const rows = await tx
      .update(activityDeliveries)
      .set({ fetchedObject: storedObject(document) })
      .where(
        and(
          eq(activityDeliveries.id, deliveryId),
          eq(activityDeliveries.direction, "inbound"),
        ),
      )
      .returning({ id: activityDeliveries.id });
    if (rows.length < 1) return false;
    await decideCarried(tx, deliveryId);
    return true;
  });
}

/**
 * Start a delivery observation.  The payload is the document before signing.
 * The sender must be a local actor of `instanceId`; otherwise nothing is
 * recorded.
 * @returns The inserted queued outbound delivery.
 * @throws {Error} When the sender is not a local actor of the instance.
 */
export async function recordOutbound(
  db: Database,
  entry: OutboundDeliveryEntry,
): Promise<ActivityDelivery> {
  return await insertDelivery(
    db,
    {
      ...entry,
      // The application clock, as inbound deliveries use, so both directions sort together.
      created: entry.created ?? Temporal.Now.instant(),
      payload: jsonb(entry.payload),
      id: uuidV7(),
      direction: "outbound",
      status: "queued",
      fetchedObject: null,
      carriedSnapshot: false,
      carriedObjectSnapshot: false,
    },
    entry.actorId == null ? [] : [{ actorId: entry.actorId, sender: true }],
  );
}

/** What a settled delivery shows; null fields for a successful attempt. */
export interface OutboundSettlement {
  readonly activityIri: string;
  readonly inboxUrl: string;
  readonly status: "sent" | "failed" | "permanently_failed" | "abandoned";
  readonly statusCode?: number | null;
  readonly error?: string | null;
  readonly responseBody?: string | null;
  /** Whether an attempt ended with this result, rather than none being made. */
  readonly attempted: boolean;
  /** Restrict a synchronous delivery to the row started by that invocation. */
  readonly id?: Uuid;
}

/**
 * Settle the most recent pending (`queued` or `failed`) delivery to an inbox,
 * keeping each ended attempt.  `sent`, `permanently_failed` and `abandoned`
 * deliveries are never changed again.
 * @returns Whether a pending delivery was found.
 */
export async function settleOutbound(
  db: Database,
  entry: OutboundSettlement,
): Promise<boolean> {
  const summary = {
    statusCode: entry.statusCode ?? null,
    error: text(entry.error),
    responseBody: text(entry.responseBody),
  };
  return await db.transaction(async (tx) => {
    const [delivery] = await tx
      .select({ id: activityDeliveries.id })
      .from(activityDeliveries)
      .where(
        and(
          eq(activityDeliveries.direction, "outbound"),
          eq(activityDeliveries.activityIri, entry.activityIri),
          eq(activityDeliveries.inboxUrl, entry.inboxUrl),
          inArray(activityDeliveries.status, ["queued", "failed"]),
          entry.id == null ? undefined : eq(activityDeliveries.id, entry.id),
        ),
      )
      .orderBy(desc(activityDeliveries.created), desc(activityDeliveries.id))
      .limit(1)
      .for("update");
    if (delivery == null) return false;
    const completed = Temporal.Now.instant();
    if (entry.attempted) {
      await tx.insert(activityDeliveryAttempts).values({
        ...summary,
        id: uuidV7(),
        deliveryId: delivery.id,
        succeeded: entry.status === "sent",
        created: completed,
      });
    }
    await tx
      .update(activityDeliveries)
      .set({ ...summary, status: entry.status, completed })
      .where(eq(activityDeliveries.id, delivery.id));
    return true;
  });
}
