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

/**
 * Fetches what the namespaces in *namespaces.mts* publish and collects their
 * findings about the catalog, for both the check and the update.
 */
import type {
  CatalogEntry,
  DocumentRequest,
  Finding,
  Namespace,
} from "./namespace.mts";
import { NAMESPACES } from "./namespaces.mts";

const FETCH_TIMEOUT_MS = 30_000;

/** The findings of one namespace. */
export interface Report {
  readonly name: string;
  /** The findings about the covered entries, or why none could be made. */
  readonly findings: ReadonlyMap<string, Finding> | Error;
}

const fetchText = async ({ url, accept }: DocumentRequest): Promise<string> => {
  const response = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} for ${accept}.`);
  }
  return await response.text();
};

// Shares one request among the namespaces that read the same document.
const memoize = (
  load: (request: DocumentRequest) => Promise<string>,
): ((request: DocumentRequest) => Promise<string>) => {
  const loaded = new Map<string, Promise<string>>();
  return (request) => {
    const key = `${request.accept} ${request.url}`;
    const cached = loaded.get(key) ?? load(request);
    loaded.set(key, cached);
    return cached;
  };
};

const coveredBy = (
  catalog: ReadonlyMap<string, CatalogEntry>,
  namespace: Namespace,
): ReadonlyMap<string, CatalogEntry> =>
  new Map([...catalog].filter(([iri, entry]) => namespace.covers(iri, entry)));

const reportOf =
  (
    catalog: ReadonlyMap<string, CatalogEntry>,
    load: (request: DocumentRequest) => Promise<string>,
  ) =>
  async (namespace: Namespace): Promise<Report> => {
    const entries = coveredBy(catalog, namespace);
    if (entries.size === 0) {
      return { name: namespace.name, findings: new Map() };
    }
    try {
      const documents = await Promise.all(
        Object.entries(namespace.documents).map(
          async ([name, request]) => [name, await load(request)] as const,
        ),
      );
      return {
        name: namespace.name,
        findings: await namespace.find(entries, new Map(documents)),
      };
    } catch (error) {
      return {
        name: namespace.name,
        findings: error instanceof Error ? error : new Error(String(error)),
      };
    }
  };

/**
 * Fetches the documents of every namespace and collects its findings.
 * @returns One report per namespace, in the order of *namespaces.mts*.
 */
export const collectReports = (
  catalog: ReadonlyMap<string, CatalogEntry>,
): Promise<readonly Report[]> =>
  Promise.all(NAMESPACES.map(reportOf(catalog, memoize(fetchText))));

// The namespace of an IRI is everything up to its last `#` or `/`.
const namespaceOf = (iri: string): string =>
  iri.slice(0, Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/")) + 1);

/**
 * Counts the entries that no namespace covers, by the namespace of their IRI.
 * @returns The counts, keyed by namespace IRI.
 */
export const uncoveredNamespaces = (
  catalog: ReadonlyMap<string, CatalogEntry>,
): ReadonlyMap<string, number> =>
  new Map(
    [
      ...Map.groupBy(
        [...catalog].filter(
          ([iri, entry]) =>
            !NAMESPACES.some((namespace) => namespace.covers(iri, entry)),
        ),
        ([iri]) => namespaceOf(iri),
      ),
    ].map(([namespace, entries]) => [namespace, entries.length]),
  );

/**
 * Formats a count of entries.
 * @returns The count with the noun in the right number.
 */
export const entries = (count: number): string =>
  `${count} ${count === 1 ? "entry" : "entries"}`;
