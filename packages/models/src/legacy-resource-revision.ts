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

import { sql } from "drizzle-orm";

import type { Transaction } from "./db.ts";
import { LegacyResourceRevisionError } from "./legacy-resource-revision-error.ts";
import type { Uuid } from "./uuid.ts";

/**
 * Captures fully written legacy typed state within its creating transaction.
 * This trusted compatibility operation performs no authorization or fetching.
 * Repeated calls return the original revision only when the typed state agrees.
 * @returns The first retained revision ID, including an unavailable snapshot.
 * @throws {LegacyResourceRevisionError} When typed state cannot be captured.
 */
export async function captureLegacyResourceRevision(
  tx: Transaction,
  resourceId: Uuid,
): Promise<Uuid> {
  try {
    const [row] = await tx
      .select({
        id: sql<Uuid>`drfed_capture_legacy_resource(${resourceId}::uuid, false)`,
      })
      .from(sql`(VALUES (1)) AS capture_input(value)`);
    if (row === undefined) {
      throw new Error("Legacy capture returned no revision.");
    }
    return row.id;
  } catch (error) {
    let detail: unknown = error;
    while (detail instanceof Error) {
      if (
        ("constraint" in detail &&
          detail.constraint === "resource_revisions_legacy_guard") ||
        ("constraint_name" in detail &&
          detail.constraint_name === "resource_revisions_legacy_guard")
      ) {
        throw new LegacyResourceRevisionError(resourceId);
      }
      detail = detail.cause;
    }
    throw error;
  }
}
