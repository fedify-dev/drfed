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

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Database, Transaction } from "./db.ts";
import {
  type ActivityLog,
  type NewActivityLog,
  type NewActivityLogActor,
  activityLogActorCollections,
  activityLogActors,
  activityLogAttempts,
  activityLogs,
  actors,
} from "./schema.ts";
import { type Uuid, uuidV7 } from "./uuid.ts";

type LogEntry = Omit<NewActivityLog, "id" | "direction" | "status">;

export interface AddressedActor {
  readonly actorId: Uuid;
  readonly viaCollectionIri?: string | null;
}

/**
 * `payload` is `undefined` for an unparsable body and `null` for JSON `null`;
 * it is stored as SQL `NULL` when jsonb cannot hold it, and `body` keeps it.
 */
export type InboundLogEntry = Omit<
  LogEntry,
  "body" | "verificationResult" | "recipientIris"
> & {
  /** Chosen in advance when something must name the log before it exists. */
  readonly id?: Uuid;
  readonly status: "received" | "acknowledged" | "unverified" | "rejected";
  readonly verificationResult: NonNullable<LogEntry["verificationResult"]>;
  readonly body: Uint8Array;
  readonly addressed?: readonly AddressedActor[];
  /** When the request arrived, before verification and handling. */
  readonly created: Temporal.Instant;
  /** When DrFed answered the request. */
  readonly completed: Temporal.Instant;
};

/** `payload` is the document before signing, without `bto` and `bcc`. */
export type OutboundLogEntry = Omit<
  LogEntry,
  | "verificationKeyId"
  | "verificationMechanism"
  | "verificationResult"
  | "body"
  | "headers"
  | "requestUrl"
  | "completed"
> & {
  readonly activityIri: string;
};

type ActorRow = Omit<NewActivityLogActor, "logId" | "created"> & {
  /** The addressed collections that reached the actor, sorted. */
  readonly collectionIris?: readonly string[];
};

/**
 * Merge the inbox owner and addressed actors into one row per actor, keeping
 * every way each was addressed, whatever order they come in.
 * @returns The actor rows of an inbound log.
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
  if (typeof value === "string") {
    return !value.includes("\0") && value.isWellFormed();
  }
  return (
    typeof value !== "object" ||
    value == null ||
    Object.entries(value).every(
      ([key, item]) => storableJson(key) && storableJson(item),
    )
  );
}

/**
 * Keep a payload jsonb cannot hold out of the log, rather than the log.
 * @returns The value to store, SQL `NULL` for such a payload.
 */
const jsonb = (payload: unknown) =>
  payload === null
    ? sql`'null'::jsonb`
    : storableJson(payload)
      ? payload
      : null;

/**
 * PostgreSQL's text holds no U+0000, which a remote response or an error
 * quoting one may carry; keep the rest of it rather than lose the log.
 * @returns The text with each U+0000 replaced by U+FFFD.
 */
const text = (value: string | null | undefined): string | null =>
  value?.replaceAll("\0", "\ufffd") ?? null;

/**
 * Refuse to relate a log to anything but local actors of its instance, which
 * neither foreign key can tell.
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
      "An activity log relates only to local actors of its instance.",
    );
  }
}

async function insertLog(
  db: Database,
  log: NewActivityLog,
  links: readonly ActorRow[],
): Promise<ActivityLog> {
  return await db.transaction(async (tx) => {
    await checkLocalActors(tx, log.instanceId, [
      log.actorId,
      ...links.map(({ actorId }) => actorId),
    ]);
    const [row] = await tx
      .insert(activityLogs)
      .values({
        ...log,
        error: text(log.error),
        responseBody: text(log.responseBody),
      })
      .returning();
    if (row == null) throw new Error("Missing activity log after insertion.");
    if (links.length > 0) {
      await tx.insert(activityLogActors).values(
        links.map(({ collectionIris: _, ...link }) => ({
          ...link,
          logId: row.id,
          created: row.created,
        })),
      );
    }
    const collections = links.flatMap(({ actorId, collectionIris = [] }) =>
      collectionIris.map((collectionIri) => ({
        logId: row.id,
        actorId,
        collectionIri,
      })),
    );
    if (collections.length > 0) {
      await tx.insert(activityLogActorCollections).values(collections);
    }
    return row;
  });
}

/**
 * Persist one inbound observation with its actor rows in one transaction.
 * The inbox owner and every addressed actor must be local actors of
 * `instanceId`; otherwise nothing is recorded.
 * @returns The inserted inbound log.
 * @throws {Error} When an actor is not a local actor of the instance.
 */
export async function recordInbound(
  db: Database,
  { addressed, body, id = uuidV7(), ...entry }: InboundLogEntry,
): Promise<ActivityLog> {
  return await insertLog(
    db,
    {
      ...entry,
      body: Buffer.from(body),
      payload: jsonb(entry.payload),
      id,
      direction: "inbound",
    },
    inboundActorRows({ actorId: entry.actorId, addressed }),
  );
}

/**
 * Record that an inbox listener ran for an inbound delivery answered before it
 * did, as a queued one is.
 * @returns Whether an acknowledged inbound log was found.
 */
export async function receiveInbound(db: Database, id: Uuid): Promise<boolean> {
  const rows = await db
    .update(activityLogs)
    .set({ status: "received" })
    .where(
      and(
        eq(activityLogs.id, id),
        eq(activityLogs.direction, "inbound"),
        eq(activityLogs.status, "acknowledged"),
      ),
    )
    .returning({ id: activityLogs.id });
  return rows.length > 0;
}

/**
 * Start a delivery observation.  The payload is the document before signing.
 * The sender must be a local actor of `instanceId`; otherwise nothing is
 * recorded.
 * @returns The inserted queued outbound log.
 * @throws {Error} When the sender is not a local actor of the instance.
 */
export async function recordOutbound(
  db: Database,
  entry: OutboundLogEntry,
): Promise<ActivityLog> {
  return await insertLog(
    db,
    {
      ...entry,
      // The application clock, as inbound logs use, so both directions sort together.
      created: entry.created ?? Temporal.Now.instant(),
      payload: jsonb(entry.payload),
      id: uuidV7(),
      direction: "outbound",
      status: "queued",
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
    const [log] = await tx
      .select({ id: activityLogs.id })
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.direction, "outbound"),
          eq(activityLogs.activityIri, entry.activityIri),
          eq(activityLogs.inboxUrl, entry.inboxUrl),
          inArray(activityLogs.status, ["queued", "failed"]),
          entry.id == null ? undefined : eq(activityLogs.id, entry.id),
        ),
      )
      .orderBy(desc(activityLogs.created), desc(activityLogs.id))
      .limit(1)
      .for("update");
    if (log == null) return false;
    const completed = Temporal.Now.instant();
    if (entry.attempted) {
      await tx.insert(activityLogAttempts).values({
        ...summary,
        id: uuidV7(),
        logId: log.id,
        succeeded: entry.status === "sent",
        created: completed,
      });
    }
    await tx
      .update(activityLogs)
      .set({ ...summary, status: entry.status, completed })
      .where(eq(activityLogs.id, log.id));
    return true;
  });
}
