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
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PgInsertValue } from "drizzle-orm/pg-core";

import type { Transaction } from "./db.ts";
import { type DocumentExpansion, expandDocument } from "./expansion.ts";
import { json } from "./json-text.ts";
import { resourceRevisions, revisionExpansions } from "./schema.ts";
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
 *                  it; otherwise the document is expanded offline here.
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
