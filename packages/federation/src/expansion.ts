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
import {
  type DocumentExpansion,
  type GatheredContext,
  expandDocument,
  expansionFailure,
} from "@drfed/models/expansion";
import {
  type DocumentLoader,
  type RemoteDocument,
  preloadedContexts,
} from "@fedify/vocab-runtime";
import jsonld from "@fedify/vocab-runtime/jsonld";

/** The remote contexts a document needs, gathered before its transaction. */
export interface GatheredContexts {
  /** Each context loaded, by requested URL, without preloaded contexts. */
  readonly contexts: ReadonlyMap<string, GatheredContext>;
  /** Why gathering stopped, when a context could not be loaded. */
  readonly failure?: string;
}

type ExpandInput = Parameters<typeof jsonld.expand>[0];

/**
 * Gathers the remote contexts a document needs by expanding it once with a
 * loader that records every context it loads, since scoped contexts and
 * imports are only found while expanding.  This accesses the network, so call
 * it before the transaction that stores the document, and pass the result to
 * {@link expandGathered} there.
 * @param document The document as stored.
 * @param contextLoader The loader that accepted the document, such as the
 *                      federation's `contextLoader`.
 * @returns The gathered contexts, and why gathering failed if it did.
 */
export async function gatherContexts(
  document: unknown,
  contextLoader: DocumentLoader,
): Promise<GatheredContexts> {
  const contexts = new Map<string, GatheredContext>();
  const recording: DocumentLoader = async (url, options) => {
    if (Object.hasOwn(preloadedContexts, url)) {
      const preloaded: RemoteDocument = {
        contextUrl: null,
        documentUrl: url,
        document: preloadedContexts[url],
      };
      return preloaded;
    }
    const remote = await contextLoader(url, options);
    contexts.set(url, {
      documentUrl: remote.documentUrl,
      document: remote.document,
    });
    return remote;
  };
  try {
    await jsonld.expand(document as ExpandInput, { documentLoader: recording });
  } catch (error) {
    return { contexts, failure: expansionFailure(error) };
  }
  return { contexts };
}

/**
 * Expands a document from contexts gathered by {@link gatherContexts},
 * without network access.  A failed gathering is recorded with its own
 * reason, which names the context that could not be loaded.
 * @param document The document the contexts were gathered for.
 * @param gathered The gathered contexts.
 * @returns The expansion.
 */
export async function expandGathered(
  document: unknown,
  gathered: GatheredContexts,
): Promise<Exclude<DocumentExpansion, { readonly outcome: "no_document" }>> {
  if (gathered.failure !== undefined) {
    return { outcome: "failed", failure: gathered.failure };
  }
  const expansion = await expandDocument(document, {
    contexts: gathered.contexts,
  });
  if (expansion.outcome === "no_document") {
    throw new TypeError("A document always has an expansion.");
  }
  return expansion;
}
