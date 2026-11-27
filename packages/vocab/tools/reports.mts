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
 * Fetches what namespaces publish and collects their findings about a
 * catalog, for both the check and the update.
 */
import { setTimeout } from "node:timers/promises";

import type {
  CatalogEntry,
  DocumentRequest,
  Finding,
  Namespace,
} from "./namespace.mts";

const FETCH_TIMEOUT_MS = 30_000;
/** How many times a request that failed for a network problem is retried. */
export const RETRIES = 3;
const RETRY_DELAY_MS = 1_000;
/** The statuses that a server that is down or overloaded answers with. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

/**
 * The documents of a namespace that a network problem kept from being
 * fetched through every retry, so that the namespace was not checked.
 */
export class UnreachableError extends Error {
  override name = "UnreachableError";
  /** Why each document could not be fetched, keyed by URL. */
  readonly failures: ReadonlyMap<string, string>;

  constructor(failures: ReadonlyMap<string, string>) {
    super(
      `skipped, since a network problem kept ${[...failures.keys()].join(", ")} from being fetched after ${RETRIES} retries`,
    );
    this.failures = failures;
  }
}

/** How {@link collectReports} fetches documents. */
export interface CollectOptions {
  /** Fetches a document; the global `fetch` by default. */
  readonly fetch?: typeof globalThis.fetch;
  /** Waits before a retry; `setTimeout` from *node:timers/promises* by default. */
  readonly sleep?: (milliseconds: number) => Promise<unknown>;
}

/** The findings of one namespace. */
export interface Report {
  readonly name: string;
  /**
   * The findings about the covered entries, or why none could be made: an
   * {@link UnreachableError} when a network problem kept a document from
   * being fetched.
   */
  readonly findings: ReadonlyMap<string, Finding> | Error;
}

// The failures that another attempt may not repeat: the request did not
// reach the server, timed out, or found the server down or overloaded.
const networkProblems = new WeakSet<Error>();

const networkProblem = (reason: string): Error => {
  const error = new Error(reason);
  networkProblems.add(error);
  return error;
};

const isNetworkProblem = (error: unknown): boolean =>
  error instanceof Error && networkProblems.has(error);

/**
 * The error codes of a connection that failed or broke, which Node's `fetch`
 * gives in the cause of its error: those of the operating system and of
 * undici.
 */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// An error, its causes, and the errors it aggregates, such as one per
// address of a host that refused every connection.
const errorsOf = (error: unknown): readonly Error[] =>
  error instanceof Error
    ? [
        error,
        ...errorsOf(error.cause),
        ...(error instanceof AggregateError
          ? error.errors.flatMap(errorsOf)
          : []),
      ]
    : [];

// A timeout of the request's signal, or a connection that failed or broke,
// whether the error is the failure itself or wraps it.  Anything else, such
// as a URL that `fetch` cannot request, is not retried.
const isNetworkFailure = (error: unknown): boolean =>
  errorsOf(error).some((failure) => {
    const { code } = failure as { readonly code?: unknown };
    return (
      failure.name === "TimeoutError" ||
      (typeof code === "string" && NETWORK_CODES.has(code))
    );
  });

const reasonOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? `${message} (${cause.message})` : message;
};

const classify =
  (url: string) =>
  (error: unknown): never => {
    throw isNetworkFailure(error)
      ? networkProblem(reasonOf(error))
      : new Error(`${url} could not be fetched: ${reasonOf(error)}`, {
          cause: error,
        });
  };

const HTTP_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

const fetchOnce = async (
  fetch: typeof globalThis.fetch,
  { url, accept }: DocumentRequest,
): Promise<string> => {
  const parsed = URL.parse(url);
  if (parsed === null || !HTTP_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`${url} is not an HTTP or HTTPS URL.`);
  }
  const response = await fetch(url, {
    headers: { accept },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(classify(url));
  if (TRANSIENT_STATUSES.has(response.status)) {
    throw networkProblem(`answered ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} for ${accept}.`);
  }
  return await response.text().catch(classify(url));
};

// Retries a request while it fails for a network problem, waiting twice as
// long before each retry.
const fetchText =
  ({
    fetch = globalThis.fetch,
    sleep = setTimeout,
  }: CollectOptions): ((request: DocumentRequest) => Promise<string>) =>
  async (request) => {
    const attempt = async (count: number): Promise<string> => {
      try {
        return await fetchOnce(fetch, request);
      } catch (error) {
        if (!isNetworkProblem(error) || count === RETRIES) throw error;
        await sleep(RETRY_DELAY_MS * 2 ** count);
        return await attempt(count + 1);
      }
    };
    return await attempt(0);
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

const errorOf = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

// Fetches every document of a namespace.  A failure other than a network
// problem wins over network problems, so that it is never skipped.
const documentsOf = async (
  namespace: Namespace,
  load: (request: DocumentRequest) => Promise<string>,
): Promise<ReadonlyMap<string, string> | Error> => {
  const requests = Object.entries(namespace.documents);
  const results = await Promise.allSettled(
    requests.map(([, request]) => load(request)),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [[requests[index]![1].url, result.reason as unknown] as const]
      : [],
  );
  const other = failures.find(([, reason]) => !isNetworkProblem(reason));
  if (other !== undefined) return errorOf(other[1]);
  if (failures.length > 0) {
    return new UnreachableError(
      new Map(failures.map(([url, reason]) => [url, reasonOf(reason)])),
    );
  }
  return new Map(
    requests.map(([name], index) => [
      name,
      (results[index] as PromiseFulfilledResult<string>).value,
    ]),
  );
};

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
    const documents = await documentsOf(namespace, load);
    if (documents instanceof Error) {
      return { name: namespace.name, findings: documents };
    }
    try {
      return {
        name: namespace.name,
        findings: await namespace.find(entries, documents),
      };
    } catch (error) {
      return { name: namespace.name, findings: errorOf(error) };
    }
  };

/**
 * Fetches the documents of every namespace and collects its findings.  A
 * request that fails for a network problem, which is a connection that fails
 * or breaks, a timeout, or an answer of 408, 429, 500, 502, 503, or 504, is
 * retried {@link RETRIES} times, and a namespace whose documents still
 * cannot be fetched is reported with an {@link UnreachableError}.  A
 * document that several namespaces read is fetched once.
 * @returns One report per namespace, in the order given.
 */
export const collectReports = (
  catalog: ReadonlyMap<string, CatalogEntry>,
  namespaces: readonly Namespace[],
  options: CollectOptions = {},
): Promise<readonly Report[]> =>
  Promise.all(namespaces.map(reportOf(catalog, memoize(fetchText(options)))));

// The namespace of an IRI is everything up to its last `#` or `/`.
const namespaceOf = (iri: string): string =>
  iri.slice(0, Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/")) + 1);

/**
 * Counts the entries that no namespace covers, by the namespace of their IRI.
 * @returns The counts, keyed by namespace IRI.
 */
export const uncoveredNamespaces = (
  catalog: ReadonlyMap<string, CatalogEntry>,
  namespaces: readonly Namespace[],
): ReadonlyMap<string, number> =>
  new Map(
    [
      ...Map.groupBy(
        [...catalog].filter(
          ([iri, entry]) =>
            !namespaces.some((namespace) => namespace.covers(iri, entry)),
        ),
        ([iri]) => namespaceOf(iri),
      ),
    ].map(([namespace, entries]) => [namespace, entries.length]),
  );
