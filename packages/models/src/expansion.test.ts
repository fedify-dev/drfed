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

import {
  expandDocument,
  expansionFailure,
  undefinedTermsOf,
} from "@drfed/models/expansion";

const AS = "https://www.w3.org/ns/activitystreams";
const AS_NS = "https://www.w3.org/ns/activitystreams#";

describe("expandDocument()", () => {
  it("expands a document with preloaded contexts", async () => {
    const result = await expandDocument({
      "@context": AS,
      type: "Note",
      content: "foo",
      contentMap: { ko: "bar" },
    });
    assert.deepEqual(result, {
      outcome: "expanded",
      document: [
        {
          "@type": [`${AS_NS}Note`],
          [`${AS_NS}content`]: [
            { "@value": "foo" },
            { "@value": "bar", "@language": "ko" },
          ],
        },
      ],
      droppedTerms: [],
      undefinedTerms: [],
    });
  });

  it("records terms kept as blank node identifiers", async () => {
    const result = await expandDocument({
      "@context": AS,
      type: "Note",
      bogus: 1,
      nested: { deep: 2 },
      tag: [{ type: "Hashtag", name: "#drfed" }],
    });
    assert.equal(result.outcome, "expanded");
    assert.deepEqual(result.undefinedTerms, [
      "Hashtag",
      "bogus",
      "deep",
      "nested",
    ]);
    assert.deepEqual(result.droppedTerms, []);
  });

  it("records terms dropped without a vocabulary mapping", async () => {
    const result = await expandDocument({
      "@context": { name: "https://schema.org/name" },
      name: "a",
      bogus: 1,
      nested: { deep: 2 },
    });
    assert.deepEqual(result, {
      outcome: "expanded",
      document: [{ "https://schema.org/name": [{ "@value": "a" }] }],
      droppedTerms: ["bogus", "nested"],
      undefinedTerms: [],
    });
  });

  it("fails on a context that is neither preloaded nor gathered", async () => {
    const result = await expandDocument({
      "@context": "https://example.test/context",
      name: "a",
    });
    assert.equal(result.outcome, "failed");
    assert.match(
      result.outcome === "failed" ? result.failure : "",
      /^jsonld\.\w+: .* Caused by Error: The context "https:\/\/example\.test\/context" was not gathered\.$/u,
    );
  });

  it("reads gathered contexts", async () => {
    const result = await expandDocument(
      { "@context": "https://example.test/context", name: "a" },
      {
        contexts: new Map([
          [
            "https://example.test/context",
            {
              documentUrl: "https://example.test/context",
              document: { "@context": { name: "https://schema.org/name" } },
            },
          ],
        ]),
      },
    );
    assert.deepEqual(result, {
      outcome: "expanded",
      document: [{ "https://schema.org/name": [{ "@value": "a" }] }],
      droppedTerms: [],
      undefinedTerms: [],
    });
  });

  it("fails on a document that is not JSON-LD", async () => {
    const result = await expandDocument({ "@context": 1 });
    assert.equal(result.outcome, "failed");
  });

  it("fails on a stored scalar instead of loading it as a URL", async () => {
    const values = [AS, "plain", 1, true, null];
    const results = await Promise.all(
      values.map(async (value) => await expandDocument(value)),
    );
    for (const result of results) {
      assert.equal(result.outcome, "failed");
      assert.match(
        result.outcome === "failed" ? result.failure : "",
        /must be an object or array/u,
      );
    }
  });

  it("keeps a node with only an @id, as Fedify does", async () => {
    assert.deepEqual(
      await expandDocument({ "@id": "https://example.test/item" }),
      {
        outcome: "expanded",
        document: [{ "@id": "https://example.test/item" }],
        droppedTerms: [],
        undefinedTerms: [],
      },
    );
  });

  it("reports each dropped occurrence", async () => {
    const terms: string[] = [];
    const result = await expandDocument(
      { "@context": {}, alpha: 1, nested: [{ alpha: 2 }] },
      { onDroppedTerm: (term) => terms.push(term) },
    );
    assert.deepEqual(result.outcome === "expanded" && result.droppedTerms, [
      "alpha",
      "nested",
    ]);
    assert.deepEqual(terms.sort(), ["alpha", "nested"]);
  });
});

describe("expansionFailure()", () => {
  it("follows causes, including jsonld details", () => {
    const root = new Error("timed out");
    const wrapped = Object.assign(new Error("loading failed"), {
      name: "jsonld.InvalidUrl",
      details: { cause: new Error("fetch failed", { cause: root }) },
    });
    assert.equal(
      expansionFailure(wrapped),
      "jsonld.InvalidUrl: loading failed Caused by Error: fetch failed Caused by Error: timed out",
    );
    assert.equal(expansionFailure("plain"), "plain");
  });
});

describe("undefinedTermsOf()", () => {
  it("ignores blank node identifiers in values", () => {
    assert.deepEqual(
      undefinedTermsOf([
        {
          "@id": "_:b0",
          [`${AS_NS}name`]: [{ "@value": "_:literal" }],
          [`${AS_NS}object`]: [{ "@id": "_:b1" }],
        },
      ]),
      [],
    );
  });
});
