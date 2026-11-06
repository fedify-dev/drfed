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

import { type Database, type Transaction, schema } from "@drfed/models";
import { loadCurrentResourceRevision } from "@drfed/models/resource-revision";
import type { Uuid } from "@drfed/models/uuid";
import type { Context } from "@fedify/fedify";
import { Object as APObject, Activity, Tombstone } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";
import { type SQL, and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { findActiveActor } from "../actor.ts";
import type { JsonObject } from "../local-write/types.ts";
import {
  activitySelection,
  objectSelection,
  toCreate,
  toObject,
} from "../object.ts";
import { canonicalizeAuthority } from "../origin.ts";
import {
  deletedLocalObject,
  inLocalOutbox,
  listedItem,
  publicAddressing,
  servedActivity,
  servedObjectRevision,
} from "../visibility.ts";
import {
  type DocumentInspection,
  type ServedDocument,
  createType,
  inspectDocument,
} from "./document.ts";
import { documentActivity, documentObject } from "./vocab.ts";

const logger = getLogger(["drfed", "federation", "serving"]);

const {
  activities,
  collectionItems,
  resourceHeads,
  resourceRevisions,
  resources,
} = schema;

/**
 * The activity routes: `create` for `/ap/creates/{id}`, which serves `Create`
 * activities, and `activity` for `/ap/activities/{id}`, which serves the
 * others.
 */
export type ActivityRoute = "create" | "activity";

/** The current revision of a saved resource, as the served queries read it. */
interface RevisionRow {
  readonly iri: string;
  readonly revisionId: string | null;
  readonly document: unknown;
}

// Lookups of deleted objects stay well below the 65,535 parameters
// PostgreSQL binds in one statement.
const lookupSize = 1000;
// Outbox pages read past hidden activities in batches that grow up to this.
const maximumBatchSize = 1000;
// The outbox counter reads the documents of this many activities at a time.
const countBatchSize = 100;

/**
 * Splits values into chunks of at most a size.
 * @returns The chunks, in order.
 */
const chunks = <T>(values: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );

// The revisions logged as unservable, so that one is logged once however
// often pages and counters read it.  It is bounded by clearing it.
const loggedRevisions = new Set<string>();
const loggedRevisionLimit = 1024;

function logOnce(row: RevisionRow, log: () => void): void {
  const key = row.revisionId ?? row.iri;
  if (loggedRevisions.has(key)) return;
  if (loggedRevisions.size >= loggedRevisionLimit) loggedRevisions.clear();
  loggedRevisions.add(key);
  log();
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads a saved revision's document for serving.  A document the write path
 * does not save, one the validator cannot read or one naming another
 * resource, can only come from a change made outside it.  It is logged and
 * left out, so that it takes down nothing but its own resource.  A document
 * whose extension values cannot be read is logged as a warning, and is not
 * served either.  Each revision is logged once.
 * @returns The inspection, or `null` when the document cannot be served.
 */
function inspectRevision(row: RevisionRow): DocumentInspection | null {
  const inspection = isJsonObject(row.document)
    ? inspectDocument(row.document)
    : null;
  if (inspection != null && inspection.served.id === row.iri) {
    if (inspection.uninterpreted) {
      logOnce(row, () =>
        logger.warn(
          "The saved document of {iri} has an extension value whose " +
            "addressing cannot be read; it is not served.",
          { iri: row.iri },
        ),
      );
    }
    return inspection;
  }
  logOnce(row, () =>
    logger.error(
      "The saved document of {iri} cannot be served; leaving it out.",
      { iri: row.iri },
    ),
  );
  return null;
}

/**
 * Applies the rules only a saved document can tell.  Content embedded at any
 * depth, including a node object in an extension value, is not served
 * publicly when it is addressed to others but not to the public, nor when it
 * is a deleted local object.  An activity at any depth whose `object` refers
 * to a deleted local object hides the document unless it is a `Delete`.  A
 * document whose blind recipients cannot be found is not served.
 * @param deleted The deleted local objects among what the document embeds
 *                and refers to.
 * @returns Whether the document is served.
 */
function isServable(
  inspection: DocumentInspection,
  deleted: ReadonlySet<string>,
): boolean {
  return (
    !inspection.restricted &&
    !inspection.uninterpreted &&
    ![...inspection.embedded, ...inspection.objectReferences].some((iri) =>
      deleted.has(iri),
    )
  );
}

/**
 * Finds the deleted local objects among IRIs, in lookups of a bounded size.
 * @returns The IRIs of those objects.
 */
async function deletedObjects(
  db: Database,
  iris: readonly string[],
): Promise<ReadonlySet<string>> {
  const rows = await Promise.all(
    chunks(iris, lookupSize).map((chunk) =>
      db
        .select({ iri: resources.iri })
        .from(resources)
        .where(
          and(inArray(resources.iri, chunk), deletedLocalObject(resources.id)),
        ),
    ),
  );
  return new Set(rows.flat().map(({ iri }) => iri));
}

/**
 * Reads saved revisions for serving, all against one lookup of the deleted
 * objects they embed or refer to.
 * @returns For each revision, its served form, or `null` when it is not
 *          served.
 */
async function servedRevisions(
  db: Database,
  rows: readonly RevisionRow[],
): Promise<(ServedDocument | null)[]> {
  const inspections = rows.map(inspectRevision);
  const deleted = await deletedObjects(db, [
    ...new Set(
      inspections.flatMap((inspection) =>
        inspection == null
          ? []
          : [...inspection.embedded, ...inspection.objectReferences],
      ),
    ),
  ]);
  return inspections.map((inspection) =>
    inspection != null && isServable(inspection, deleted)
      ? inspection.served
      : null,
  );
}

/**
 * Finds the activity a route serves.  A legacy `Create` is serialized from
 * its typed row; a saved activity is its current document without blind
 * recipients, served at the route its type was given.
 * @param ctx The context of the request, whose host must be the instance of
 *            the actor whose outbox holds the activity.
 * @returns The activity, or `null` when the route does not serve it.
 */
export async function findServedActivity(
  db: Database,
  ctx: Context<unknown>,
  id: Uuid,
  route: ActivityRoute,
): Promise<Activity | null> {
  const [row] = await db
    .select({
      iri: resources.iri,
      typed: sql<boolean>`${activities.id} is not null`,
      revisionId: resourceRevisions.id,
      document: resourceRevisions.document,
    })
    .from(resources)
    .leftJoin(activities, eq(activities.id, resources.id))
    .leftJoin(resourceHeads, eq(resourceHeads.resourceId, resources.id))
    .leftJoin(
      resourceRevisions,
      eq(resourceRevisions.id, resourceHeads.revisionId),
    )
    .where(
      and(
        eq(resources.id, id),
        inLocalOutbox(resources.id, canonicalizeAuthority(ctx.host)),
        servedActivity(resources.id),
      ),
    )
    .limit(1);
  if (row == null) return null;
  if (row.typed) {
    if (route !== "create") return null;
    const activity = await db.query.activities.findFirst({
      where: { id },
      with: activitySelection,
    });
    return activity == null ? null : toCreate(ctx, activity);
  }
  const [served] = await servedRevisions(db, [row]);
  if (served == null || (served.type === createType) !== (route === "create")) {
    return null;
  }
  return documentActivity(served);
}

/**
 * Finds the object the actor's object route serves.  A legacy object is
 * serialized from its typed row; a saved one is its current document without
 * blind recipients.  A deleted object is a `Tombstone` with only its `id`
 * and deletion time.
 * @param ctx The context of the request, whose host must be the actor's
 *            instance.
 * @returns The object, or `null` when the route does not serve it.
 */
export async function findServedObject(
  db: Database,
  ctx: Context<unknown>,
  actorId: Uuid,
  id: Uuid,
): Promise<APObject | null> {
  const typed = await db.query.objects.findFirst({
    where: {
      id,
      actorId,
      RAW: (table) => publicAddressing(table.id),
      actor: {
        localId: { isNotNull: true },
        deleted: { isNull: true },
        instance: { host: canonicalizeAuthority(ctx.host) },
      },
    },
    with: objectSelection,
  });
  if (typed != null) {
    return typed.deleted == null
      ? toObject(ctx, typed)
      : new Tombstone({
          id: new URL(typed.resource.iri),
          deleted: typed.deleted,
        });
  }
  const actor = await findActiveActor(db, ctx, actorId);
  if (actor == null) return null;
  const [row] = await db
    .select({
      iri: resources.iri,
      kind: resourceRevisions.kind,
      revisionId: resourceRevisions.id,
      document: resourceRevisions.document,
      deleted: resourceRevisions.deleted,
    })
    .from(resources)
    .innerJoin(resourceHeads, eq(resourceHeads.resourceId, resources.id))
    .innerJoin(
      resourceRevisions,
      eq(resourceRevisions.id, resourceHeads.revisionId),
    )
    .where(
      and(
        eq(resources.id, id),
        eq(resources.kind, "object"),
        servedObjectRevision(resources.id, actor.resource.iri),
      ),
    )
    .limit(1);
  if (row == null) return null;
  if (row.kind === "whiteout") {
    return new Tombstone({ id: new URL(row.iri), deleted: row.deleted });
  }
  if (row.kind !== "snapshot") return null;
  const [served] = await servedRevisions(db, [row]);
  return served == null ? null : documentObject(served);
}

/** One page of an outbox. */
export interface OutboxPage {
  readonly items: readonly Activity[];
  /** The position after which the next page starts, if there is one. */
  readonly nextCursor: number | null;
}

const outboxItems = (outboxId: Uuid): SQL =>
  and(
    eq(collectionItems.collectionId, outboxId),
    listedItem(collectionItems.position),
    servedActivity(collectionItems.itemId),
  )!;

/**
 * Loads a batch of outbox items after a position, in the order of their
 * positions.
 * @returns Each item's position, and its activity or `null` when it is not
 *          served.
 */
async function loadOutboxBatch(
  db: Database,
  ctx: Context<unknown>,
  outboxId: Uuid,
  after: number | null,
  size: number,
): Promise<
  { readonly position: number; readonly activity: Activity | null }[]
> {
  const rows = await db
    .select({
      id: collectionItems.itemId,
      position: collectionItems.position,
      iri: resources.iri,
      typed: sql<boolean>`${activities.id} is not null`,
      revisionId: resourceRevisions.id,
      document: resourceRevisions.document,
    })
    .from(collectionItems)
    .innerJoin(resources, eq(resources.id, collectionItems.itemId))
    .leftJoin(activities, eq(activities.id, collectionItems.itemId))
    .leftJoin(
      resourceHeads,
      eq(resourceHeads.resourceId, collectionItems.itemId),
    )
    .leftJoin(
      resourceRevisions,
      eq(resourceRevisions.id, resourceHeads.revisionId),
    )
    .where(
      and(
        outboxItems(outboxId),
        after == null ? undefined : gt(collectionItems.position, after),
      ),
    )
    .orderBy(asc(collectionItems.position))
    .limit(size);
  const typedIds = rows.filter(({ typed }) => typed).map(({ id }) => id);
  const typed =
    typedIds.length === 0
      ? []
      : await db.query.activities.findMany({
          where: { id: { in: typedIds } },
          with: activitySelection,
        });
  const byId = new Map(typed.map((activity) => [activity.id, activity]));
  const saved = rows.filter((row) => !row.typed);
  const served = new Map(
    (await servedRevisions(db, saved)).map((document, index) => [
      saved[index]!.id,
      document,
    ]),
  );
  return rows.map((row) => {
    // Listed items have positions; see listedItem().
    const position = row.position!;
    if (row.typed) {
      const activity = byId.get(row.id);
      return {
        position,
        activity: activity == null ? null : toCreate(ctx, activity),
      };
    }
    const document = served.get(row.id);
    return {
      position,
      activity: document == null ? null : documentActivity(document),
    };
  });
}

/**
 * Loads one page of the served activities in an outbox, in the order of
 * their positions, where the newest has the smallest.  Legacy `Create`
 * activities and saved activities are mixed in that one order.  Items their
 * documents leave out are read past, in batches that double up to a bound,
 * until the page is full, and a next page is promised only when a served
 * activity follows, so that no page but the last is short and none is empty
 * with a next page.
 * @param after The position the page starts after; `null` for the first.
 * @returns The page.
 */
export async function loadOutboxPage(
  db: Database,
  ctx: Context<unknown>,
  outboxId: Uuid,
  after: number | null,
  limit: number,
): Promise<OutboxPage> {
  const items: { readonly position: number; readonly activity: Activity }[] =
    [];
  let cursor = after;
  let size = limit + 1;
  // One served activity past the page tells whether a next page exists.
  while (items.length <= limit) {
    // Each batch starts where the previous one ended.
    // oxlint-disable-next-line no-await-in-loop
    const batch = await loadOutboxBatch(db, ctx, outboxId, cursor, size);
    for (const { position, activity } of batch) {
      if (activity != null) items.push({ position, activity });
    }
    if (batch.length < size) break;
    cursor = batch.at(-1)!.position;
    if (size < maximumBatchSize) size = Math.min(size * 2, maximumBatchSize);
  }
  const page = items.slice(0, limit);
  return {
    items: page.map(({ activity }) => activity),
    nextCursor: items.length > limit ? page.at(-1)!.position : null,
  };
}

/**
 * Counts the served activities in an outbox, by the same rules as
 * {@link loadOutboxPage}.  The documents of its saved activities are read in
 * batches of a bounded size, since only they tell what those activities
 * embed and refer to.
 * @returns The number of activities its pages hold together.
 */
export async function countOutbox(
  db: Database,
  outboxId: Uuid,
): Promise<number> {
  const [legacy] = await db
    .select({ count: sql<number>`cast(count(*) as integer)` })
    .from(collectionItems)
    .innerJoin(activities, eq(activities.id, collectionItems.itemId))
    .where(outboxItems(outboxId));
  let count = legacy?.count ?? 0;
  let after: Uuid | null = null;
  for (;;) {
    // Each batch starts after the item the previous one ended with.
    // oxlint-disable-next-line no-await-in-loop
    const saved = await db
      .select({
        id: collectionItems.itemId,
        iri: resources.iri,
        revisionId: resourceRevisions.id,
        document: resourceRevisions.document,
      })
      .from(collectionItems)
      .innerJoin(resources, eq(resources.id, collectionItems.itemId))
      .innerJoin(
        resourceHeads,
        eq(resourceHeads.resourceId, collectionItems.itemId),
      )
      .innerJoin(
        resourceRevisions,
        eq(resourceRevisions.id, resourceHeads.revisionId),
      )
      .leftJoin(activities, eq(activities.id, collectionItems.itemId))
      .where(
        and(
          outboxItems(outboxId),
          isNull(activities.id),
          after == null ? undefined : gt(collectionItems.itemId, after),
        ),
      )
      .orderBy(asc(collectionItems.itemId))
      .limit(countBatchSize);
    // oxlint-disable-next-line no-await-in-loop
    const served = await servedRevisions(db, saved);
    count += served.filter((document) => document != null).length;
    if (saved.length < countBatchSize) return count;
    after = saved.at(-1)!.id;
  }
}

/** A saved activity's current document, as #145 dispatches it. */
export interface ActivitySnapshot {
  readonly revisionId: Uuid;
  /** The protected document, including blind recipients. */
  readonly document: JsonObject;
}

/**
 * Loads a saved activity's current document, whether it is published or
 * not, without applying any serving rule; callers authorize its use and
 * remove blind recipients from public output with `publicDocument()`.
 * @returns The snapshot, or `null` when the resource is not a saved
 *          activity.
 */
export async function loadActivitySnapshot(
  db: Database | Transaction,
  id: Uuid,
): Promise<ActivitySnapshot | null> {
  const resource = await db.query.resources.findFirst({
    where: { id },
    columns: { kind: true },
  });
  if (resource?.kind !== "activity") return null;
  const head = await loadCurrentResourceRevision(db, id);
  return head?.kind === "snapshot" && isJsonObject(head.document)
    ? { revisionId: head.id, document: head.document }
    : null;
}
