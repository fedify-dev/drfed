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
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import type { Database, Transaction } from "./db.ts";
import { type DocumentExpansion, expandDocument } from "./expansion.ts";
import { json } from "./json-text.ts";
import {
  type ResourceRevision,
  objects,
  resourceRevisions,
  revisionExpansions,
} from "./schema.ts";
import { storableText } from "./text.ts";
import { type Uuid, validateUuid } from "./uuid.ts";

type ExpansionRow = PgInsertValue<typeof revisionExpansions>;

/**
 * The expansion of a new snapshot revision's document, computed by the caller
 * before the transaction that stores it.
 */
export type RevisionExpansionInput = Exclude<
  DocumentExpansion,
  { readonly outcome: "no_document" }
> & {
  /**
   * The revision whose expanded document this one was taken from, for an
   * object embedded in a received activity.
   */
  readonly sourceRevisionId?: Uuid;
};

function terms(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((term) => typeof term === "string")
  );
}

/**
 * Checks the shape of a caller's expansion.
 * @param input The expansion.
 * @throws {TypeError} If it is not an expanded or failed outcome.
 */
export function checkRevisionExpansion(
  input: unknown,
): asserts input is RevisionExpansionInput {
  if (input === null || typeof input !== "object") {
    throw new TypeError("Expected a document expansion.");
  }
  const expansion = input as Partial<Record<string, unknown>>;
  if (
    expansion.sourceRevisionId !== undefined &&
    (typeof expansion.sourceRevisionId !== "string" ||
      !validateUuid(expansion.sourceRevisionId))
  ) {
    throw new TypeError("Expected a canonical source revision UUID.");
  }
  if (expansion.outcome === "expanded") {
    if (
      !Array.isArray(expansion.document) ||
      !terms(expansion.droppedTerms) ||
      !terms(expansion.undefinedTerms)
    ) {
      throw new TypeError("Expected an expanded document and its terms.");
    }
    return;
  }
  if (expansion.outcome === "failed") {
    if (typeof expansion.failure !== "string") {
      throw new TypeError("Expected the reason of a failed expansion.");
    }
    return;
  }
  throw new TypeError("Expected an expanded or failed outcome.");
}

// Error messages may quote a document, so keep them storable in `text`.
function storableFailure(failure: string): string {
  if (storableText(failure)) return failure;
  return failure.replaceAll("\0", "\uFFFD").toWellFormed();
}

/**
 * Builds the row recording a revision's expansion.
 * @param revisionId The revision.
 * @param expansion The expansion, or null for a revision without a document.
 * @returns The row to insert.
 */
export function expansionRow(
  revisionId: Uuid,
  expansion: RevisionExpansionInput | null,
): ExpansionRow {
  if (expansion === null) return { revisionId, outcome: "no_document" };
  const sourceRevisionId = expansion.sourceRevisionId ?? null;
  if (expansion.outcome === "failed") {
    return {
      revisionId,
      outcome: "failed",
      failure: storableFailure(expansion.failure),
      sourceRevisionId,
    };
  }
  return {
    revisionId,
    outcome: "expanded",
    document: sql`${json(expansion.document)}::json`,
    droppedTerms: sql`${json(expansion.droppedTerms)}::json`,
    undefinedTerms: sql`${json(expansion.undefinedTerms)}::json`,
    sourceRevisionId,
  };
}

/**
 * Records the expansions of a resource's revisions that have none, after a
 * legacy capture.  Revisions the capture created have none; a revision it
 * reused has none only if it predates expansions, and the capture has then
 * verified that its document equals the typed one.  Either way the snapshot's
 * document is the one `expansion` was computed from.
 * @param tx The capturing transaction.
 * @param resourceId The captured resource.
 * @param expansion The expansion of the typed document, if the caller computed
 *                  it; otherwise the document is expanded offline here, from
 *                  preloaded contexts only, when it was written locally.  A
 *                  received, embedded, or fetched snapshot may need remote
 *                  contexts or the context it inherits, so without one it is
 *                  left without a row for the backfill, which loads them;
 *                  a failure recorded offline would keep the backfill away.
 */
export async function recordMissingExpansions(
  tx: Transaction,
  resourceId: Uuid,
  expansion?: RevisionExpansionInput,
): Promise<void> {
  const missing = await tx
    .select({
      id: resourceRevisions.id,
      kind: resourceRevisions.kind,
      capture: resourceRevisions.capture,
      document: resourceRevisions.document,
    })
    .from(resourceRevisions)
    .leftJoin(
      revisionExpansions,
      eq(revisionExpansions.revisionId, resourceRevisions.id),
    )
    .where(
      and(
        eq(resourceRevisions.resourceId, resourceId),
        isNull(revisionExpansions.revisionId),
      ),
    )
    .orderBy(asc(resourceRevisions.sequence));
  const rows: ExpansionRow[] = [];
  for (const revision of missing) {
    if (revision.kind !== "snapshot") {
      rows.push(expansionRow(revision.id, null));
      continue;
    }
    if (expansion === undefined && revision.capture !== "local") continue;
    // oxlint-disable-next-line no-await-in-loop
    const own = expansion ?? (await expandDocument(revision.document));
    if (own.outcome === "no_document") {
      throw new TypeError("A snapshot revision has a document.");
    }
    rows.push(expansionRow(revision.id, own));
  }
  if (rows.length > 0) {
    await tx.insert(revisionExpansions).values(rows).onConflictDoNothing();
  }
}

/** A revision the backfill has not reached, as {@link listUnexpandedRevisions} lists it. */
export interface UnexpandedRevision {
  readonly id: Uuid;
  readonly resourceId: Uuid;
  readonly kind: ResourceRevision["kind"];
  readonly capture: ResourceRevision["capture"];
  readonly document: unknown;
}

/**
 * Lists revisions without an expansion, in ID order.
 * @param db The database.
 * @param options Where to continue from, and how many to list.
 * @returns Up to `limit` revisions after `after`.
 */
export async function listUnexpandedRevisions(
  db: Database | Transaction,
  options: { readonly after?: Uuid; readonly limit: number },
): Promise<UnexpandedRevision[]> {
  return await db
    .select({
      id: resourceRevisions.id,
      resourceId: resourceRevisions.resourceId,
      kind: resourceRevisions.kind,
      capture: resourceRevisions.capture,
      document: resourceRevisions.document,
    })
    .from(resourceRevisions)
    .leftJoin(
      revisionExpansions,
      eq(revisionExpansions.revisionId, resourceRevisions.id),
    )
    .where(
      and(
        isNull(revisionExpansions.revisionId),
        options.after === undefined
          ? undefined
          : gt(resourceRevisions.id, options.after),
      ),
    )
    .orderBy(asc(resourceRevisions.id))
    .limit(options.limit);
}

/**
 * Finds the revision of the activity that first carried an embedded object,
 * the one its typed row names, which an embedded revision's expansion is
 * taken from.
 * @param db The database.
 * @param objectId The embedded object's resource.
 * @returns The activity's first revision, or null if there is none.
 */
export async function findCarryingActivityRevision(
  db: Database | Transaction,
  objectId: Uuid,
): Promise<{ readonly id: Uuid; readonly document: unknown } | null> {
  const [row] = await db
    .select({
      id: resourceRevisions.id,
      document: resourceRevisions.document,
    })
    .from(objects)
    .innerJoin(
      resourceRevisions,
      and(
        eq(resourceRevisions.resourceId, objects.activityId),
        eq(resourceRevisions.sequence, 1),
        eq(resourceRevisions.kind, "snapshot"),
      ),
    )
    .where(eq(objects.id, objectId))
    .limit(1);
  return row ?? null;
}

/**
 * Records the expansion of a revision that has none.  An existing row is kept,
 * so that the backfill can run again or alongside new writes.
 * @param db The database.
 * @param revisionId The revision.
 * @param expansion Its expansion, or null for a revision without a document,
 *                  which must be `unavailable` or a `whiteout`.
 * @returns Whether a row was inserted.
 * @throws {TypeError} If the revision does not exist, or the expansion does
 *                     not suit its kind.
 */
export async function recordRevisionExpansion(
  db: Database | Transaction,
  revisionId: Uuid,
  expansion: RevisionExpansionInput | null,
): Promise<boolean> {
  if (expansion !== null) checkRevisionExpansion(expansion);
  const [revision] = await db
    .select({ kind: resourceRevisions.kind })
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, revisionId))
    .limit(1);
  if (revision === undefined) {
    throw new TypeError("The revision does not exist.");
  }
  // A revision's kind never changes, so checking it first is enough.
  if ((revision.kind === "snapshot") !== (expansion !== null)) {
    throw new TypeError(
      revision.kind === "snapshot"
        ? "A snapshot has a document to expand."
        : `A revision of kind ${revision.kind} has no document to expand.`,
    );
  }
  const inserted = await db
    .insert(revisionExpansions)
    .values(expansionRow(revisionId, expansion))
    .onConflictDoNothing()
    .returning({ revisionId: revisionExpansions.revisionId });
  return inserted.length > 0;
}
