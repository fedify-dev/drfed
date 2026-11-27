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
  type CatalogEntry,
  anchorNamespace,
  contextNamespace,
  differencesOf,
  documentOf,
  fragmentOf,
  messagesOf,
  rdfNamespace,
  sameSet,
  sameValue,
} from "./namespace.mts";

const EX = "https://example.org/ns#";

const entry = (fields: Partial<CatalogEntry> = {}): CatalogEntry => ({
  description: { en: "A [ X ] b." },
  source: "https://example.org/doc#a",
  ...fields,
});

describe("documentOf and fragmentOf", () => {
  it("split a link into its document and decoded fragment", () => {
    assert.equal(
      documentOf("https://example.org/doc/#a"),
      "https://example.org/doc",
    );
    assert.equal(fragmentOf("https://example.org/doc#a%20b"), "a b");
  });
});

describe("sameSet", () => {
  it("ignores order but not membership", () => {
    assert.equal(sameSet(["a", "b"], ["b", "a"]), true);
    assert.equal(sameSet(["a"], ["a", "b"]), false);
  });
});

describe("sameValue", () => {
  it("compares descriptions as normalized text", () => {
    assert.equal(sameValue("description", "a [ X ]\n b", "a [X] b"), true);
    assert.equal(sameValue("description", "a", "b"), false);
  });

  it("compares ranges regardless of order", () => {
    assert.equal(sameValue("range", ["a", "b"], ["b", "a"]), true);
    assert.equal(sameValue("range", ["a"], ["b"]), false);
  });

  it("compares other fields as they are", () => {
    assert.equal(sameValue("multiple", true, true), true);
    assert.equal(sameValue("source", "a", "b"), false);
  });
});

describe("differencesOf", () => {
  it("reports a catalog description that keeps spaces inside brackets", () => {
    assert.deepEqual(differencesOf(entry(), { description: "A [ X ]  b." }), {
      description: "A [X] b.",
    });
  });

  it("accepts a description that differs only in whitespace", () => {
    const wrapped = entry({ description: { en: "A\n[X] b." } });
    assert.deepEqual(differencesOf(wrapped, { description: "A [X] b." }), {});
  });

  it("selects only the fields that differ", () => {
    const listed = entry({ range: [`${EX}A`, `${EX}B`], multiple: true });
    assert.deepEqual(
      differencesOf(listed, {
        range: [`${EX}B`, `${EX}A`],
        multiple: false,
        source: "https://example.org/doc#a",
      }),
      { multiple: false },
    );
  });

  it("treats a missing range as empty", () => {
    assert.deepEqual(differencesOf(entry(), { range: [] }), {});
    assert.deepEqual(differencesOf(entry(), { range: [`${EX}A`] }), {
      range: [`${EX}A`],
    });
  });
});

describe("messagesOf", () => {
  it("lists the problems, then one message per differing field", () => {
    assert.deepEqual(
      messagesOf(entry({ multiple: true }), {
        origin: "Example",
        expected: { multiple: false },
        problems: ["something is wrong"],
      }),
      ["something is wrong", "multiple is true, but Example gives false"],
    );
  });
});

const findOne = async (
  namespace: ReturnType<typeof contextNamespace>,
  entries: ReadonlyMap<string, CatalogEntry>,
  documents: Record<string, string>,
) => await namespace.find(entries, new Map(Object.entries(documents)));

describe("contextNamespace", () => {
  const namespace = contextNamespace({
    name: "Example",
    iri: EX,
    url: "https://example.org/ns",
  });

  it("covers the entries under its IRI", () => {
    assert.equal(namespace.covers(`${EX}a`, entry()), true);
    assert.equal(namespace.covers("https://other.example/#a", entry()), false);
  });

  it("reports an IRI that no term expands to", async () => {
    const findings = await findOne(
      namespace,
      new Map([
        [`${EX}a`, entry()],
        [`${EX}b`, entry()],
      ]),
      { context: JSON.stringify({ "@context": { ex: EX, term: "ex:a" } }) },
    );
    assert.deepEqual(findings.get(`${EX}a`)?.problems, []);
    assert.deepEqual(findings.get(`${EX}b`)?.problems, [
      "no term of the context at https://example.org/ns expands to it",
    ]);
  });
});

describe("rdfNamespace", () => {
  const namespace = rdfNamespace({
    name: "Example",
    iri: EX,
    url: "https://example.org/ns",
    format: "turtle",
  });

  it("gives the range and functionality the vocabulary declares", async () => {
    const findings = await findOne(
      namespace,
      new Map([
        [`${EX}a`, entry()],
        [`${EX}b`, entry()],
      ]),
      {
        vocabulary: `
          @prefix ex: <${EX}> .
          @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
          @prefix owl: <http://www.w3.org/2002/07/owl#> .
          ex:a a owl:FunctionalProperty ; rdfs:range ex:A .`,
      },
    );
    assert.deepEqual(findings.get(`${EX}a`), {
      origin: "https://example.org/ns",
      expected: { range: [`${EX}A`], multiple: false },
      problems: [],
    });
    assert.deepEqual(findings.get(`${EX}b`)?.problems, [
      "https://example.org/ns does not define it",
    ]);
  });

  const VOCABULARY = `
    @prefix ex: <${EX}> .
    @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    ex:plain a rdf:Property .
    ex:several rdfs:range ex:A, ex:B .`;

  it("reports values the vocabulary does not declare, without removing them", async () => {
    const findings = await findOne(
      namespace,
      new Map([
        [`${EX}plain`, entry({ range: [`${EX}A`], multiple: false })],
        [`${EX}several`, entry()],
      ]),
      { vocabulary: VOCABULARY },
    );
    assert.deepEqual(findings.get(`${EX}plain`), {
      origin: "https://example.org/ns",
      expected: {},
      problems: [
        `range is ["${EX}A"], but https://example.org/ns declares none`,
        "multiple is false, but https://example.org/ns does not declare it functional",
      ],
    });
    assert.deepEqual(findings.get(`${EX}several`)?.problems, [
      "https://example.org/ns declares a range that is not one class IRI or a union of them, so range is not checked",
    ]);
  });

  it("leaves the fields another definition gives", async () => {
    const elsewhere = rdfNamespace({
      name: "Example",
      iri: EX,
      url: "https://example.org/ns",
      format: "turtle",
      definedElsewhere: { [`${EX}plain`]: ["range", "multiple"] },
    });
    const findings = await findOne(
      elsewhere,
      new Map([[`${EX}plain`, entry({ range: [`${EX}A`], multiple: false })]]),
      { vocabulary: VOCABULARY },
    );
    assert.deepEqual(findings.get(`${EX}plain`)?.problems, []);
  });
});

describe("anchorNamespace", () => {
  const namespace = anchorNamespace({
    name: "Example",
    iri: EX,
    url: "https://example.org/doc",
  });

  it("checks that the source points to an anchor of the page", async () => {
    const findings = await findOne(
      namespace,
      new Map([
        [`${EX}a`, entry({ source: "https://example.org/doc/#a" })],
        [`${EX}b`, entry({ source: "https://example.org/doc#b" })],
        [`${EX}c`, entry({ source: "https://other.example/doc#c" })],
        [`${EX}d`, entry({ source: "https://example.org/doc" })],
      ]),
      { page: '<h2 id="a">a</h2><p id=""></p>' },
    );
    assert.deepEqual(findings.get(`${EX}a`)?.problems, []);
    assert.deepEqual(findings.get(`${EX}b`)?.problems, [
      "https://example.org/doc has no anchor #b",
    ]);
    assert.deepEqual(findings.get(`${EX}c`)?.problems, [
      "source is not in https://example.org/doc",
    ]);
    assert.deepEqual(findings.get(`${EX}d`)?.problems, [
      "source has no fragment",
    ]);
  });
});
