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
// Revisions are expanded one at a time, so that contexts are loaded in order
// and a run can stop between revisions.
// oxlint-disable no-await-in-loop

import type { Database } from "@drfed/models";
import { undefinedTermsOf } from "@drfed/models/expansion";
import {
  type RevisionExpansionInput,
  type UnexpandedRevision,
  findCarryingActivityRevision,
  listFailedRevisions,
  listUnexpandedRevisions,
  loadRevisionExpansion,
  recordRevisionExpansion,
  retryRevisionExpansion,
} from "@drfed/models/resource-revision";
import type { Uuid } from "@drfed/models/uuid";
import {
  type DocumentLoader,
  type RemoteDocument,
  getDocumentLoader,
  preloadedContexts,
} from "@fedify/vocab-runtime";

import { embeddedExpansion, embeddedObject, objectNodeOf } from "./embedded.ts";
import { expandGathered, gatherContexts } from "./expansion.ts";

/** Options for {@link backfillExpansions}. */
export interface BackfillExpansionsOptions {
  /**
   * Loads remote contexts.  A context loaded is reused for the rest of the
   * run; one that fails to load is tried again for the next revision that
   * needs it, up to {@link MAX_CONTEXT_ATTEMPTS} times in all, so that a
   * transient error does not fail every revision while an unreachable server
   * does not stall the run.  Defaults to Fedify's loader allowing private
   * addresses, as the server loads them.
   */
  readonly contextLoader?: DocumentLoader;
  /** How many revisions to list at a time.  Defaults to 100. */
  readonly batchSize?: number;
  /**
   * Also expands again the snapshot revisions whose expansion failed, such as
   * when a context could not be loaded, replacing a row that now succeeds or
   * fails for another reason.  Defaults to false.
   */
  readonly retryFailed?: boolean;
  /** Stops the run between revisions. */
  readonly signal?: AbortSignal;
}

/** How many revisions a backfill recorded or replaced, by outcome. */
export interface BackfillExpansionsResult {
  readonly expanded: number;
  readonly failed: number;
  readonly noDocument: number;
}

/**
 * Records the expansions of revisions that have none, such as those stored
 * before expansions were.  A revision whose row another writer records first
 * keeps that row, so the backfill can run again, or alongside a server.  An
 * object embedded in a received activity is expanded from the activity that
 * first carried it; when that activity's revision cannot be found, or no
 * longer holds the object, the failure is recorded.  Contexts are loaded
 * outside any transaction.
 * @param db The database.
 * @param options The context loader and how to run.
 * @returns How many revisions were recorded, by outcome.
 */
export async function backfillExpansions(
  db: Database,
  options: BackfillExpansionsOptions = {},
): Promise<BackfillExpansionsResult> {
  const contextLoader = cachedLoader(
    options.contextLoader ?? getDocumentLoader({ allowPrivateAddress: true }),
  );
  const limit = options.batchSize ?? 100;
  const counts = { expanded: 0, failed: 0, noDocument: 0 };
  // Count what was stored: serializing may turn an expansion into a failure.
  const counting =
    (write: typeof recordRevisionExpansion): Record =>
    async (revisionId, expansion) => {
      const stored = await write(db, revisionId, expansion);
      if (stored === "no_document") counts.noDocument += 1;
      else if (stored !== null) counts[stored] += 1;
    };
  const writers: Writers = {
    record: counting(recordRevisionExpansion),
    ...(options.retryFailed === true
      ? { retry: counting(retryRevisionExpansion) }
      : {}),
  };
  const passes = [
    { list: listUnexpandedRevisions, write: writers.record },
    ...(writers.retry === undefined
      ? []
      : [{ list: listFailedRevisions, write: writers.retry }]),
  ];
  for (const { list, write } of passes) {
    let after: Uuid | undefined;
    for (;;) {
      options.signal?.throwIfAborted();
      const batch = await list(db, {
        ...(after === undefined ? {} : { after }),
        limit,
      });
      if (batch.length === 0) break;
      for (const revision of batch) {
        options.signal?.throwIfAborted();
        await write(
          revision.id,
          await expansionOf(db, revision, contextLoader, writers),
        );
      }
      after = batch.at(-1)?.id;
    }
  }
  return counts;
}

type Record = (
  revisionId: Uuid,
  expansion: RevisionExpansionInput | null,
) => Promise<void>;

interface Writers {
  /** Records an expansion for a revision without one. */
  readonly record: Record;
  /** Replaces a failed expansion, when the run retries failures. */
  readonly retry?: Record;
}

/** How many times a backfill run tries to load a context that keeps failing. */
export const MAX_CONTEXT_ATTEMPTS = 3;

function cachedLoader(loader: DocumentLoader): DocumentLoader {
  const loaded = new Map<string, Promise<RemoteDocument>>();
  const failures = new Map<string, number>();
  return async (url, options) => {
    // Preloaded contexts are served as the federation's loader serves them.
    if (Object.hasOwn(preloadedContexts, url)) {
      const preloaded: RemoteDocument = {
        contextUrl: null,
        documentUrl: url,
        document: preloadedContexts[url],
      };
      return preloaded;
    }
    const cached = loaded.get(url);
    if (cached !== undefined) return await cached;
    const remote = loader(url, options);
    loaded.set(url, remote);
    try {
      return await remote;
    } catch (error) {
      // Forget a failure, unless the context has failed too often, so that
      // the next revision that needs it tries again.
      const count = (failures.get(url) ?? 0) + 1;
      failures.set(url, count);
      if (count < MAX_CONTEXT_ATTEMPTS) loaded.delete(url);
      throw error;
    }
  };
}

async function expansionOf(
  db: Database,
  revision: UnexpandedRevision,
  contextLoader: DocumentLoader,
  writers: Writers,
): Promise<RevisionExpansionInput | null> {
  if (revision.kind !== "snapshot") return null;
  const { document } = revision;
  if (revision.capture !== "embedded") {
    return await expandGathered(
      document,
      await gatherContexts(document, contextLoader),
    );
  }
  const parent = await findCarryingActivityRevision(db, revision.resourceId);
  if (parent === null) {
    return {
      outcome: "failed",
      failure: "No revision of the activity that carried the object was found.",
    };
  }
  const gathered = await gatherContexts(parent.document, contextLoader);
  // Take the object from the activity's recorded expansion, recording it
  // first if needed, so that both agree even if a context changed between
  // runs.  The object is the node with its IRI there, so finding it does not
  // depend on how the current contexts map the activity's `object`.
  // A failed activity row is retried first when the run retries failures.
  let recorded = await loadRevisionExpansion(db, parent.id);
  const write =
    recorded === null
      ? writers.record
      : recorded.outcome === "failed"
        ? writers.retry
        : undefined;
  if (write !== undefined) {
    await write(parent.id, await expandGathered(parent.document, gathered));
    recorded = await loadRevisionExpansion(db, parent.id);
  }
  if (recorded === null) throw new Error("The activity has no expansion.");
  if (recorded.outcome !== "expanded" || recorded.document === null) {
    return {
      outcome: "failed",
      failure:
        recorded.failure ?? "The activity that carried the object has none.",
      sourceRevisionId: parent.id,
    };
  }
  const activity = {
    outcome: "expanded",
    document: recorded.document,
    droppedTerms: recorded.droppedTerms ?? [],
    undefinedTerms: recorded.undefinedTerms ?? [],
  } as const;
  const node = objectNodeOf(activity.document);
  if (node?.["@id"] !== revision.resourceIri) {
    return {
      outcome: "failed",
      failure: "The activity that carried the object does not hold it.",
      sourceRevisionId: parent.id,
    };
  }
  // Dropped terms are counted by replacing the object where the current
  // contexts find it; where they do not, or fail to load, none are recorded.
  const found = await embeddedObject(parent.document, contextLoader);
  if (
    found === undefined ||
    "failure" in found ||
    JSON.stringify(found.document) !== JSON.stringify(document)
  ) {
    return {
      outcome: "expanded",
      document: [node],
      droppedTerms: [],
      undefinedTerms: undefinedTermsOf([node]),
      sourceRevisionId: parent.id,
    };
  }
  return {
    ...(await embeddedExpansion(
      parent.document,
      found.path,
      gathered,
      activity,
    )),
    sourceRevisionId: parent.id,
  };
}
