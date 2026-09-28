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

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "./db.ts";
import {
  type ActivityLog,
  type NewActivityLog,
  activityLogs,
} from "./schema.ts";
import { type Uuid, uuidV7 } from "./uuid.ts";

type LogEntry = Omit<NewActivityLog, "id" | "direction" | "status">;
export type InboundLogEntry = LogEntry & {
  readonly status: "received" | "unverified" | "rejected";
};
export type OutboundLogEntry = Omit<LogEntry, "verificationKeyId"> & {
  readonly activityIri: string;
};

/**
 * Persist one inbound observation without reserializing its original payload.
 * @returns The inserted inbound log.
 */
export async function recordInbound(
  db: Database,
  entry: InboundLogEntry,
): Promise<ActivityLog> {
  const [row] = await db
    .insert(activityLogs)
    .values({
      ...entry,
      payload: entry.payload === null ? sql`'null'::jsonb` : entry.payload,
      id: uuidV7(),
      direction: "inbound",
    })
    .returning();
  if (row == null) throw new Error("Missing inbound log after insertion.");
  return row;
}

/**
 * Start a delivery observation. Outbound keys are not verification keys.
 * @returns The inserted queued outbound log.
 */
export async function recordOutbound(
  db: Database,
  entry: OutboundLogEntry,
): Promise<ActivityLog> {
  const [row] = await db
    .insert(activityLogs)
    .values({
      ...entry,
      payload: entry.payload === null ? sql`'null'::jsonb` : entry.payload,
      id: uuidV7(),
      direction: "outbound",
      status: "queued",
      verificationKeyId: null,
    })
    .returning();
  if (row == null) throw new Error("Missing outbound log after insertion.");
  return row;
}

/** Settle pending deliveries; successful or permanent results are never overwritten. */
export async function settleOutbound(
  db: Database,
  entry: {
    readonly activityIri: string;
    readonly inboxUrl: string;
    readonly status: "sent" | "failed" | "permanently_failed";
    readonly statusCode?: number | null;
    readonly error?: string | null;
    /** Restrict a synchronous completion to the row started by that invocation. */
    readonly id?: Uuid;
    /** Leave detailed failure callbacks intact when settling a thrown exception. */
    readonly onlyQueued?: boolean;
  },
): Promise<void> {
  await db
    .update(activityLogs)
    .set({
      status: entry.status,
      statusCode: entry.statusCode ?? null,
      error: entry.error ?? null,
    })
    .where(
      and(
        eq(activityLogs.direction, "outbound"),
        eq(activityLogs.activityIri, entry.activityIri),
        eq(activityLogs.inboxUrl, entry.inboxUrl),
        entry.id == null ? undefined : eq(activityLogs.id, entry.id),
        inArray(
          activityLogs.status,
          entry.status === "sent" || entry.onlyQueued
            ? ["queued"]
            : ["queued", "failed"],
        ),
      ),
    );
}
