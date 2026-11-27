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

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type CatalogEntry, type Namespace, under } from "./namespace.mts";
import {
  RETRIES,
  UnreachableError,
  collectReports,
  uncoveredNamespaces,
} from "./reports.mts";

const EX = "https://example.org/ns#";
const DOC = "https://example.org/doc";
const OTHER = "https://example.org/other";

const entry: CatalogEntry = {
  description: { en: "A." },
  source: `${DOC}#a`,
};
const CATALOG: ReadonlyMap<string, CatalogEntry> = new Map([
  [`${EX}a`, entry],
  ["https://elsewhere.example/ns#b", entry],
]);

// A namespace whose finding about each entry carries the documents it read.
const namespaceOf = (
  name: string,
  urls: readonly string[],
  iri = EX,
): Namespace => ({
  name,
  documents: Object.fromEntries(
    urls.map((url, index) => [`d${index}`, { url, accept: "text/plain" }]),
  ),
  covers: under(iri),
  find: (entries, documents) =>
    new Map(
      [...entries.keys()].map((key) => [
        key,
        { origin: name, expected: {}, problems: [...documents.values()] },
      ]),
    ),
});

type Answer = Response | Error;

// A fetch that answers each URL with its answers in turn, the last one for
// every further request, and records the requests.
const fakeFetch = (answers: Readonly<Record<string, readonly Answer[]>>) => {
  const requests: string[] = [];
  const fetch = (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    const queue = answers[url] ?? [new Response(url)];
    const answer =
      queue[requests.filter((request) => request === url).length] ??
      queue.at(-1)!;
    requests.push(url);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer.clone());
  };
  return { fetch: fetch as typeof globalThis.fetch, requests };
};

const collect = async (
  namespaces: readonly Namespace[],
  answers: Readonly<Record<string, readonly Answer[]>> = {},
) => {
  const { fetch, requests } = fakeFetch(answers);
  const waits: number[] = [];
  const reports = await collectReports(CATALOG, namespaces, {
    fetch,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });
  return { reports, requests, waits };
};

// How Node's fetch fails when the server refuses the connection.
const failure = (): Error =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    }),
  });

describe("collectReports", () => {
  it("gives each namespace's findings from the documents it fetched", async () => {
    const { reports, requests } = await collect([namespaceOf("One", [DOC])]);
    assert.equal(reports[0]?.name, "One");
    const findings = reports[0]?.findings;
    assert.ok(findings instanceof Map);
    assert.deepEqual(findings.get(`${EX}a`), {
      origin: "One",
      expected: {},
      problems: [DOC],
    });
    assert.deepEqual(requests, [DOC]);
  });

  it("fetches a document that two namespaces read once", async () => {
    const { requests } = await collect([
      namespaceOf("One", [DOC]),
      namespaceOf("Two", [DOC]),
    ]);
    assert.deepEqual(requests, [DOC]);
  });

  it("fetches nothing for a namespace that covers no entry", async () => {
    const { reports, requests } = await collect([
      namespaceOf("None", [DOC], "https://none.example/#"),
    ]);
    assert.deepEqual(reports[0]?.findings, new Map());
    assert.deepEqual(requests, []);
  });

  it("retries a network problem and skips the namespace after the retries", async () => {
    const { reports, requests, waits } = await collect(
      [namespaceOf("One", [DOC, OTHER])],
      { [DOC]: [failure()] },
    );
    const findings = reports[0]?.findings;
    assert.ok(findings instanceof UnreachableError);
    assert.deepEqual(
      findings.failures,
      new Map([[DOC, "fetch failed (connect ECONNREFUSED 127.0.0.1:443)"]]),
    );
    assert.equal(requests.filter((url) => url === DOC).length, RETRIES + 1);
    assert.deepEqual(waits, [1000, 2000, 4000]);
  });

  it("retries a timeout and a refusal from every address", async () => {
    const timeout = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    );
    const refused = new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("connect ECONNREFUSED ::1:443"), {
          code: "ECONNREFUSED",
        }),
      ]),
    });
    const { reports, requests } = await collect([namespaceOf("One", [DOC])], {
      [DOC]: [timeout, refused, new Response("up")],
    });
    assert.ok(reports[0]?.findings instanceof Map);
    assert.equal(requests.length, 3);
  });

  it("retries a failure whose cause is a timeout", async () => {
    const wrapped = new TypeError("fetch failed", {
      cause: new DOMException("The operation timed out.", "TimeoutError"),
    });
    const { reports, requests } = await collect([namespaceOf("One", [DOC])], {
      [DOC]: [wrapped],
    });
    assert.ok(reports[0]?.findings instanceof UnreachableError);
    assert.equal(requests.length, RETRIES + 1);
  });

  it("does not retry or skip a failure that is not of the network", async () => {
    const { reports, requests } = await collect([namespaceOf("One", [DOC])], {
      [DOC]: [
        new TypeError("fetch failed", { cause: new Error("unknown scheme") }),
      ],
    });
    const findings = reports[0]?.findings;
    assert.ok(findings instanceof Error);
    assert.ok(!(findings instanceof UnreachableError));
    assert.match(findings.message, /could not be fetched: fetch failed/u);
    assert.equal(requests.length, 1);
  });

  it("does not request a URL that is not HTTP or HTTPS", async () => {
    const { reports, requests } = await collect([
      namespaceOf("Unparsable", ["not a url"]),
      namespaceOf("Not HTTP", ["htps://example.org/doc"]),
    ]);
    for (const { findings } of reports) {
      assert.ok(findings instanceof Error);
      assert.ok(!(findings instanceof UnreachableError));
      assert.match(findings.message, /is not an HTTP or HTTPS URL/u);
    }
    assert.equal(reports.length, 2);
    assert.deepEqual(requests, []);
  });

  it("retries an answer of a server that is down", async () => {
    const { reports, requests } = await collect([namespaceOf("One", [DOC])], {
      [DOC]: [new Response("", { status: 503 }), new Response("up")],
    });
    assert.ok(reports[0]?.findings instanceof Map);
    assert.equal(requests.length, 2);
  });

  it("does not retry or skip any other failing answer", async () => {
    const { reports, requests } = await collect(
      [namespaceOf("One", [DOC, OTHER])],
      {
        [DOC]: [new Response("", { status: 404 })],
        [OTHER]: [failure()],
      },
    );
    const findings = reports[0]?.findings;
    assert.ok(findings instanceof Error);
    assert.ok(!(findings instanceof UnreachableError));
    assert.match(findings.message, /answered 404/u);
    assert.equal(requests.filter((url) => url === DOC).length, 1);
  });

  it("reports a namespace that fails to read its documents", async () => {
    const broken: Namespace = {
      ...namespaceOf("Broken", [DOC]),
      find: () => {
        throw new Error("unreadable");
      },
    };
    const { reports } = await collect([broken]);
    const findings = reports[0]?.findings;
    assert.ok(findings instanceof Error);
    assert.equal(findings.message, "unreadable");
  });
});

describe("uncoveredNamespaces", () => {
  it("counts the entries that no namespace covers", () => {
    assert.deepEqual(
      uncoveredNamespaces(CATALOG, [namespaceOf("One", [DOC])]),
      new Map([["https://elsewhere.example/ns#", 1]]),
    );
  });
});
