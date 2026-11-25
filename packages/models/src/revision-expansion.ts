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
  type RevisionExpansion,
  objects,
  resourceRevisions,
  resources,
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

// `text` and `jsonb` refuse U+0000 and unpaired surrogates; error messages
// and expanded documents may contain both.
function storableString(value: string): string {
  if (storableText(value)) return value;
  return value.replaceAll("\0", "\uFFFD").toWellFormed();
}

/**
 * Normalizes an expanded document for `jsonb`, replacing in every string and
 * key what it refuses with U+FFFD.  The stored document keeps the exact
 * values, so the expansion need not.
 * @param value Part of an expanded document.
 * @returns The value with storable strings and keys.
 */
function storableJson(value: unknown): unknown {
  if (typeof value === "string") return storableString(value);
  if (Array.isArray(value)) return value.map(storableJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      storableString(key),
      storableJson(entry),
    ]),
  );
}

/**
 * Checks that an embedded snapshot's expansion names the revision it was
 * taken from, since an embedded document cannot be expanded on its own.
 * @param capture How the snapshot was captured.
 * @param expansion Its expansion.
 * @throws {TypeError} If an embedded expansion has no source.
 */
export function checkExpansionSource(
  capture: ResourceRevision["capture"] | undefined,
  expansion: RevisionExpansionInput | null | undefined,
): void {
  if (
    capture === "embedded" &&
    expansion?.outcome === "expanded" &&
    expansion.sourceRevisionId === undefined
  ) {
    throw new TypeError(
      "An embedded snapshot's expansion names the revision it was taken from.",
    );
  }
}

/**
 * An expansion serialized for storage, so that it is fixed when the revision
 * is prepared rather than when the row is inserted.
 */
export interface SerializedExpansion {
  readonly outcome: ResourceRevisionExpansionOutcome;
  /** The expanded document as JSON text, for a `jsonb` column. */
  readonly document: string | null;
  readonly droppedTerms: readonly string[] | null;
  readonly undefinedTerms: readonly string[] | null;
  readonly failure: string | null;
  readonly sourceRevisionId: Uuid | null;
}

type ResourceRevisionExpansionOutcome = ExpansionRow["outcome"];

/**
 * Serializes an expansion for storage.  An expanded document that JSON cannot
 * represent, such as one keeping a number beyond the double range, is
 * recorded as a failure instead of failing the write.  Strings are normalized
 * for `jsonb` and `text`, and `jsonb` stores negative zero as zero.
 * @param expansion The expansion, or null for a revision without a document.
 * @returns The serialized expansion.
 */
export function serializeExpansion(
  expansion: RevisionExpansionInput | null,
): SerializedExpansion {
  const none = {
    document: null,
    droppedTerms: null,
    undefinedTerms: null,
    failure: null,
  };
  if (expansion === null) {
    return { ...none, outcome: "no_document", sourceRevisionId: null };
  }
  const sourceRevisionId = expansion.sourceRevisionId ?? null;
  if (expansion.outcome === "expanded") {
    try {
      return {
        outcome: "expanded",
        document: json(storableJson(expansion.document)),
        droppedTerms: expansion.droppedTerms.map(storableString),
        undefinedTerms: expansion.undefinedTerms.map(storableString),
        failure: null,
        sourceRevisionId,
      };
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return {
        ...none,
        outcome: "failed",
        failure: `The expanded document cannot be stored as JSON: ${error.message}`,
        sourceRevisionId,
      };
    }
  }
  return {
    ...none,
    outcome: "failed",
    failure: storableString(expansion.failure),
    sourceRevisionId,
  };
}

/**
 * Builds the row recording a revision's expansion.
 * @param revisionId The revision.
 * @param serialized The serialized expansion.
 * @returns The row to insert.
 */
export function expansionRow(
  revisionId: Uuid,
  serialized: SerializedExpansion,
): ExpansionRow {
  return {
    revisionId,
    outcome: serialized.outcome,
    document:
      serialized.document === null ? null : sql`${serialized.document}::jsonb`,
    droppedTerms:
      serialized.droppedTerms === null ? null : [...serialized.droppedTerms],
    undefinedTerms:
      serialized.undefinedTerms === null
        ? null
        : [...serialized.undefinedTerms],
    failure: serialized.failure,
    sourceRevisionId: serialized.sourceRevisionId,
  };
}

/**
 * Records the expansions of a resource's revisions that have none, after a
 * legacy capture.  Revisions the capture created have none; a revision it
 * reused has none only if it predates expansions, and the capture has then
 * verified that its document equals the typed one.  `expansion` is of that
 * document, so it is recorded only for the snapshot the capture returned;
 * other snapshots without one are handled as if none were given.
 * @param tx The capturing transaction.
 * @param resourceId The captured resource.
 * @param capturedId The revision the capture returned.
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
  capturedId: Uuid,
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
  const given =
    expansion === undefined ? undefined : serializeExpansion(expansion);
  for (const revision of missing) {
    if (revision.kind !== "snapshot") {
      rows.push(expansionRow(revision.id, serializeExpansion(null)));
      continue;
    }
    if (given === undefined || revision.id !== capturedId) {
      if (revision.capture !== "local") continue;
      // oxlint-disable-next-line no-await-in-loop
      const own = await expandDocument(revision.document);
      if (own.outcome === "no_document") {
        throw new TypeError("A snapshot revision has a document.");
      }
      rows.push(expansionRow(revision.id, serializeExpansion(own)));
      continue;
    }
    checkExpansionSource(revision.capture, expansion);
    rows.push(expansionRow(revision.id, given));
  }
  if (rows.length > 0) {
    await tx.insert(revisionExpansions).values(rows).onConflictDoNothing();
  }
}

/** A revision the backfill has not reached, as {@link listUnexpandedRevisions} lists it. */
export interface UnexpandedRevision {
  readonly id: Uuid;
  readonly resourceId: Uuid;
  /** The IRI of the revision's resource. */
  readonly resourceIri: string;
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
      resourceIri: resources.iri,
      kind: resourceRevisions.kind,
      capture: resourceRevisions.capture,
      document: resourceRevisions.document,
    })
    .from(resourceRevisions)
    .innerJoin(resources, eq(resources.id, resourceRevisions.resourceId))
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
 * @returns The outcome of the row inserted, which is `failed` for an
 *          expansion JSON cannot hold, or null if the revision already had
 *          one.
 * @throws {TypeError} If the revision does not exist, or the expansion does
 *                     not suit its kind.
 */
export async function recordRevisionExpansion(
  db: Database | Transaction,
  revisionId: Uuid,
  expansion: RevisionExpansionInput | null,
): Promise<RevisionExpansion["outcome"] | null> {
  if (expansion !== null) checkRevisionExpansion(expansion);
  const serialized = serializeExpansion(expansion);
  const [revision] = await db
    .select({
      kind: resourceRevisions.kind,
      capture: resourceRevisions.capture,
    })
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
  checkExpansionSource(revision.capture, expansion);
  const inserted = await db
    .insert(revisionExpansions)
    .values(expansionRow(revisionId, serialized))
    .onConflictDoNothing()
    .returning({ outcome: revisionExpansions.outcome });
  return inserted[0]?.outcome ?? null;
}
