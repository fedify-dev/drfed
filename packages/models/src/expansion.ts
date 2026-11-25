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
   * Remote contexts gathered beforehand, by URL, besides the contexts
   * preloaded by `@fedify/vocab-runtime`.  Expansion never accesses the
   * network, so it may run inside a transaction; a context found in neither
   * fails the expansion.
   */
  readonly contexts?: ReadonlyMap<string, GatheredContext>;
  /**
   * Called for each occurrence of a dropped term, before duplicates are
   * removed from `droppedTerms`.
   */
  readonly onDroppedTerm?: (term: string) => void;
}

/** A remote context gathered before an expansion, keyed by requested URL. */
export interface GatheredContext {
  /** The URL the context was finally loaded from, after redirects. */
  readonly documentUrl: string;
  /**
   * The context a response linked to, such as with an HTTP `Link` header,
   * which the processor applies with the loaded one.
   */
  readonly contextUrl?: string | null;
  readonly document: unknown;
}

function contextReader(
  contexts: ReadonlyMap<string, GatheredContext> = new Map(),
): DocumentLoader {
  return (url) => {
    const gathered = Object.hasOwn(preloadedContexts, url)
      ? { documentUrl: url, document: preloadedContexts[url] }
      : contexts.get(url);
    if (gathered === undefined) {
      return Promise.reject(
        new Error(`The context ${JSON.stringify(url)} was not gathered.`),
      );
    }
    const remote: RemoteDocument = {
      contextUrl: gathered.contextUrl ?? null,
      documentUrl: gathered.documentUrl,
      document: gathered.document,
    };
    return Promise.resolve(remote);
  };
}

/**
 * Options the JSON-LD processor is given, as Fedify gives them when it reads
 * a document, so that a node with only an `@id` is kept.
 */
export const EXPAND_OPTIONS = { keepFreeFloatingNodes: true } as const;

/**
 * Why a stored value cannot be expanded, if it cannot: the processor reads a
 * string as the URL of a document to load, which a stored value is not.
 * @param document The stored value.
 * @returns The failure reason, or undefined for an object or array.
 */
export function unexpandableValue(document: unknown): string | undefined {
  if (document !== null && typeof document === "object") return undefined;
  return `A JSON-LD document must be an object or array, not ${
    document === null ? "null" : typeof document
  }.`;
}

const DROPPED_TERM_EVENTS: ReadonlySet<string> = new Set([
  "invalid property",
  "invalid reverse property",
]);

type ExpandInput = Parameters<typeof jsonld.expand>[0];
type ExpandOptions = NonNullable<Parameters<typeof jsonld.expand>[1]>;

/**
 * Expands a document with the JSON-LD processor Fedify uses, reading
 * contexts only from those preloaded and those given.  Expansion failures are
 * returned as a `failed` outcome rather than thrown.
 * @param document The document as stored.
 * @param options Options, including gathered contexts.
 * @returns The outcome of the expansion.
 */
export async function expandDocument(
  document: unknown,
  options: ExpandDocumentOptions = {},
): Promise<DocumentExpansion> {
  const unexpandable = unexpandableValue(document);
  if (unexpandable !== undefined) {
    return { outcome: "failed", failure: unexpandable };
  }
  const dropped: string[] = [];
  let expanded: unknown;
  try {
    expanded = await jsonld.expand(
      document as ExpandInput,
      {
        ...EXPAND_OPTIONS,
        documentLoader: contextReader(options.contexts),
        eventHandler: ({ event }: { event: JsonLdEvent }) => {
          const property = event.details?.property;
          if (
            DROPPED_TERM_EVENTS.has(event.code) &&
            typeof property === "string"
          ) {
            dropped.push(property);
            options.onDroppedTerm?.(property);
          }
        },
      } as ExpandOptions,
    );
  } catch (error) {
    return { outcome: "failed", failure: expansionFailure(error) };
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

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === ""
      ? error.name
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function causeOf(error: unknown): unknown {
  if (error === null || typeof error !== "object") return undefined;
  const { details, cause } = error as {
    readonly details?: { readonly cause?: unknown };
    readonly cause?: unknown;
  };
  return details?.cause ?? cause;
}

/**
 * Describes why an expansion failed, followed by its causes, since the
 * JSON-LD processor wraps the error a context loader threw.
 * @param error The thrown error.
 * @returns The reason recorded for a `failed` outcome.
 */
export function expansionFailure(error: unknown): string {
  const reasons = [describeError(error)];
  const seen = new Set<unknown>([error]);
  for (
    let cause = causeOf(error);
    cause !== undefined && cause !== null && !seen.has(cause);
    cause = causeOf(cause)
  ) {
    seen.add(cause);
    reasons.push(describeError(cause));
  }
  return reasons.join(" Caused by ");
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
