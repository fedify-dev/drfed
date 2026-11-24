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
  type DocumentLoader,
  type RemoteDocument,
  preloadedContexts,
} from "@fedify/vocab-runtime";
import jsonld from "@fedify/vocab-runtime/jsonld";

/**
 * How the JSON-LD expansion of a revision's document turned out.
 *
 *  -  `expanded`: the document was expanded.  `droppedTerms` lists the terms
 *     the expansion discarded because no context defined them;
 *     `undefinedTerms` lists the terms a vocabulary such as ActivityStreams,
 *     whose context maps undefined terms with `"@vocab": "_:"`, kept as
 *     blank node identifiers instead.
 *  -  `failed`: the document could not be expanded, for example because a
 *     context could not be loaded.
 *  -  `no_document`: the revision has no document to expand.
 */
export type DocumentExpansion =
  | {
      readonly outcome: "expanded";
      readonly document: readonly unknown[];
      readonly droppedTerms: readonly string[];
      readonly undefinedTerms: readonly string[];
    }
  | { readonly outcome: "failed"; readonly failure: string }
  | { readonly outcome: "no_document" };

/** Options for {@link expandDocument}. */
export interface ExpandDocumentOptions {
  /**
   * Loads remote contexts.  Defaults to {@link offlineContextLoader}, which
   * never accesses the network.
   */
  readonly contextLoader?: DocumentLoader;
}

/**
 * A context loader that serves only the contexts preloaded by
 * `@fedify/vocab-runtime` and rejects every other URL without network
 * access.
 * @param url The context URL.
 * @returns The preloaded context document.
 */
export const offlineContextLoader: DocumentLoader = (url) => {
  if (!Object.hasOwn(preloadedContexts, url)) {
    return Promise.reject(
      new Error(`The context ${JSON.stringify(url)} is not preloaded.`),
    );
  }
  const document: RemoteDocument = {
    contextUrl: null,
    documentUrl: url,
    document: preloadedContexts[url],
  };
  return Promise.resolve(document);
};

const DROPPED_TERM_EVENTS: ReadonlySet<string> = new Set([
  "invalid property",
  "invalid reverse property",
]);

type ExpandInput = Parameters<typeof jsonld.expand>[0];
type ExpandOptions = NonNullable<Parameters<typeof jsonld.expand>[1]>;

/**
 * Expands a document with the JSON-LD processor Fedify uses.  Expansion
 * failures are returned as a `failed` outcome rather than thrown.
 * @param document The document as stored.
 * @param options Options, including the context loader.
 * @returns The outcome of the expansion.
 */
export async function expandDocument(
  document: unknown,
  options: ExpandDocumentOptions = {},
): Promise<DocumentExpansion> {
  const dropped: string[] = [];
  let expanded: unknown;
  try {
    expanded = await jsonld.expand(
      document as ExpandInput,
      {
        documentLoader: options.contextLoader ?? offlineContextLoader,
        eventHandler: ({ event }: { event: JsonLdEvent }) => {
          const property = event.details?.property;
          if (
            DROPPED_TERM_EVENTS.has(event.code) &&
            typeof property === "string"
          ) {
            dropped.push(property);
          }
        },
      } as ExpandOptions,
    );
  } catch (error) {
    return { outcome: "failed", failure: failureOf(error) };
  }
  const nodes = Array.isArray(expanded) ? (expanded as unknown[]) : [expanded];
  return {
    outcome: "expanded",
    document: nodes,
    droppedTerms: distinct(dropped),
    undefinedTerms: undefinedTermsOf(nodes),
  };
}

interface JsonLdEvent {
  readonly code: string;
  readonly details?: { readonly property?: unknown };
}

function failureOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message === ""
      ? error.name
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Lists the terms an expanded document keeps as blank node identifiers, in
 * property names and `@type` values, without their `_:` prefix.
 * @param expanded An expanded document.
 * @returns The terms, sorted and without duplicates.
 */
export function undefinedTermsOf(expanded: readonly unknown[]): string[] {
  const terms: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key.startsWith("_:")) terms.push(key.slice(2));
      if (key === "@type") {
        for (const type of Array.isArray(entry) ? entry : [entry]) {
          if (typeof type === "string" && type.startsWith("_:")) {
            terms.push(type.slice(2));
          }
        }
      } else if (key !== "@value") {
        visit(entry);
      }
    }
  };
  visit(expanded);
  return distinct(terms);
}
