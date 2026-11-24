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
  offlineContextLoader,
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

  it("fails on a context that is not preloaded by default", async () => {
    const result = await expandDocument({
      "@context": "https://example.test/context",
      name: "a",
    });
    assert.equal(result.outcome, "failed");
    assert.match(
      result.outcome === "failed" ? result.failure : "",
      /^jsonld\.\w+: /u,
    );
  });

  it("loads remote contexts through the given loader", async () => {
    const urls: string[] = [];
    const result = await expandDocument(
      { "@context": "https://example.test/context", name: "a" },
      {
        contextLoader: (url) => {
          urls.push(url);
          return Promise.resolve({
            contextUrl: null,
            documentUrl: url,
            document: { "@context": { name: "https://schema.org/name" } },
          });
        },
      },
    );
    assert.deepEqual(urls, ["https://example.test/context"]);
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
});

describe("offlineContextLoader()", () => {
  it("serves preloaded contexts", async () => {
    const remote = await offlineContextLoader(AS);
    assert.equal(remote.documentUrl, AS);
    assert.ok(remote.document != null);
  });

  it("rejects other URLs", async () => {
    await assert.rejects(offlineContextLoader("https://example.test/context"));
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
