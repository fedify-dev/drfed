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

import { expandGathered, gatherContexts } from "@drfed/federation/expansion";
import type { DocumentLoader } from "@fedify/vocab-runtime";

const AS = "https://www.w3.org/ns/activitystreams";
const NAME = "https://schema.org/name";

function loader(
  documents: Record<
    string,
    { readonly documentUrl?: string; readonly document: unknown }
  >,
  requested: string[] = [],
): DocumentLoader {
  return (url) => {
    requested.push(url);
    const found = documents[url];
    if (found === undefined) {
      return Promise.reject(new Error(`offline: ${url}`));
    }
    return Promise.resolve({
      contextUrl: null,
      documentUrl: found.documentUrl ?? url,
      document: found.document,
    });
  };
}

describe("gatherContexts()", () => {
  it("records remote contexts, scoped and imported ones included", async () => {
    const requested: string[] = [];
    const document = {
      "@context": [AS, "https://example.test/outer"],
      type: "Thing",
      inner: { name: "a" },
    };
    const gathered = await gatherContexts(
      document,
      loader(
        {
          "https://example.test/outer": {
            documentUrl: "https://example.test/moved/outer",
            document: {
              "@context": {
                Thing: "https://example.test/ns#Thing",
                inner: {
                  "@id": "https://example.test/ns#inner",
                  "@context": "scoped",
                },
              },
            },
          },
          // Resolved against the redirected URL of the outer context.
          "https://example.test/moved/scoped": {
            document: { "@context": { name: NAME } },
          },
        },
        requested,
      ),
    );
    assert.equal(gathered.failure, undefined);
    // Preloaded contexts never reach the given loader.
    assert.deepEqual(requested, [
      "https://example.test/outer",
      "https://example.test/moved/scoped",
    ]);
    assert.deepEqual(
      [...gathered.contexts.keys()],
      ["https://example.test/outer", "https://example.test/moved/scoped"],
    );
    // Expanding again from the gathered contexts gives the same result.
    const expansion = await expandGathered(document, gathered);
    assert.equal(expansion.outcome, "expanded");
    assert.deepEqual(
      expansion.outcome === "expanded" ? expansion.document : null,
      [
        {
          "@type": ["https://example.test/ns#Thing"],
          "https://example.test/ns#inner": [{ [NAME]: [{ "@value": "a" }] }],
        },
      ],
    );
  });

  it("keeps the reason a context could not be loaded", async () => {
    const gathered = await gatherContexts(
      { "@context": "https://example.test/missing", name: "a" },
      loader({}),
    );
    assert.match(
      gathered.failure ?? "",
      /Caused by Error: offline: https:\/\/example\.test\/missing$/u,
    );
    assert.deepEqual(await expandGathered({}, gathered), {
      outcome: "failed",
      failure: gathered.failure,
    });
  });
});

describe("expandGathered()", () => {
  it("replays a context a response linked to", async () => {
    const document = { "@context": "https://example.test/a", name: "x" };
    const gathered = await gatherContexts(document, (url) =>
      Promise.resolve(
        url === "https://example.test/a"
          ? {
              contextUrl: "https://example.test/b",
              documentUrl: url,
              document: { "@context": {} },
            }
          : {
              contextUrl: null,
              documentUrl: url,
              document: { "@context": { name: NAME } },
            },
      ),
    );
    assert.deepEqual(await expandGathered(document, gathered), {
      outcome: "expanded",
      document: [{ [NAME]: [{ "@value": "x" }] }],
      droppedTerms: [],
      undefinedTerms: [],
    });
  });

  it("never loads a stored string as a document", async () => {
    const requested: string[] = [];
    const gathered = await gatherContexts(
      "https://example.test/doc",
      loader({}, requested),
    );
    assert.deepEqual(requested, []);
    assert.equal(
      (await expandGathered("https://example.test/doc", gathered)).outcome,
      "failed",
    );
  });

  it("fails on contexts that were not gathered", async () => {
    const expansion = await expandGathered(
      { "@context": "https://example.test/other", name: "a" },
      { contexts: new Map() },
    );
    assert.equal(expansion.outcome, "failed");
    assert.match(
      expansion.outcome === "failed" ? expansion.failure : "",
      /was not gathered\.$/u,
    );
  });
});
