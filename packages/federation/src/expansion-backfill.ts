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
import {
  type RevisionExpansionInput,
  type UnexpandedRevision,
  findCarryingActivityRevision,
  listUnexpandedRevisions,
  recordRevisionExpansion,
} from "@drfed/models/resource-revision";
import type { Uuid } from "@drfed/models/uuid";
import {
  type DocumentLoader,
  type RemoteDocument,
  getDocumentLoader,
  preloadedContexts,
} from "@fedify/vocab-runtime";

import { embeddedExpansion, embeddedObject } from "./embedded.ts";
import { expandGathered, gatherContexts } from "./expansion.ts";

/** Options for {@link backfillExpansions}. */
export interface BackfillExpansionsOptions {
  /**
   * Loads remote contexts; each URL is loaded once per run.  Defaults to
   * Fedify's loader allowing private addresses, as the server loads them.
   */
  readonly contextLoader?: DocumentLoader;
  /** How many revisions to list at a time.  Defaults to 100. */
  readonly batchSize?: number;
  /** Stops the run between revisions. */
  readonly signal?: AbortSignal;
}

/** How many revisions a backfill recorded, by outcome. */
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
  const contextLoader = loadOnce(
    options.contextLoader ?? getDocumentLoader({ allowPrivateAddress: true }),
  );
  const limit = options.batchSize ?? 100;
  const counts = { expanded: 0, failed: 0, noDocument: 0 };
  let after: Uuid | undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const batch = await listUnexpandedRevisions(db, {
      ...(after === undefined ? {} : { after }),
      limit,
    });
    if (batch.length === 0) break;
    for (const revision of batch) {
      options.signal?.throwIfAborted();
      const expansion = await expansionOf(db, revision, contextLoader);
      if (await recordRevisionExpansion(db, revision.id, expansion)) {
        if (expansion === null) counts.noDocument += 1;
        else counts[expansion.outcome] += 1;
      }
    }
    after = batch.at(-1)?.id;
  }
  return counts;
}

function loadOnce(loader: DocumentLoader): DocumentLoader {
  const loaded = new Map<string, Promise<RemoteDocument>>();
  return (url, options) => {
    // Preloaded contexts are served as the federation's loader serves them.
    if (Object.hasOwn(preloadedContexts, url)) {
      const preloaded: RemoteDocument = {
        contextUrl: null,
        documentUrl: url,
        document: preloadedContexts[url],
      };
      return Promise.resolve(preloaded);
    }
    let remote = loaded.get(url);
    if (remote === undefined) {
      remote = loader(url, options);
      loaded.set(url, remote);
    }
    return remote;
  };
}

async function expansionOf(
  db: Database,
  revision: UnexpandedRevision,
  contextLoader: DocumentLoader,
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
  const found = await embeddedObject(parent.document, contextLoader);
  if (
    found === undefined ||
    JSON.stringify(found.document) !== JSON.stringify(document)
  ) {
    return {
      outcome: "failed",
      failure: "The activity that carried the object does not hold it.",
      sourceRevisionId: parent.id,
    };
  }
  const gathered = await gatherContexts(parent.document, contextLoader);
  const activity = await expandGathered(parent.document, gathered);
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
