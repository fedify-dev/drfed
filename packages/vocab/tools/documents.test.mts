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
  collapseWhitespace,
  normalizeText,
  parseActivityPub,
  parseAnchors,
  parseContext,
  parseNamespaceTerms,
  parseVocabulary,
  resolveRange,
} from "./documents.mts";

const AS = "https://www.w3.org/ns/activitystreams#";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const EX = "https://example.org/ns#";

describe("collapseWhitespace", () => {
  it("collapses and trims whitespace and keeps brackets", () => {
    assert.equal(collapseWhitespace("  a\n\t b [ X ]  "), "a b [ X ]");
  });
});

describe("normalizeText", () => {
  it("also drops the spaces just inside brackets", () => {
    assert.equal(normalizeText(" a\n [ BCP47 ]  b "), "a [BCP47] b");
  });
});

describe("parseContext", () => {
  it("expands terms as JSON-LD 1.1 does", async () => {
    const terms = await parseContext({
      "@context": {
        ex: EX,
        "@vocab": "https://vocab.example/#",
        plain: "ex:plain",
        dashed: "ex:some-prop",
        dotted: { "@id": "ex:a.b", "@type": "@id" },
        vocabRelative: { "@type": "@id" },
        sub: "ex:sub/",
        chained: "sub:x",
        absolute: "https://other.example/#y",
      },
    });
    assert.equal(terms.get("ex"), EX);
    assert.equal(terms.get("plain"), `${EX}plain`);
    assert.equal(terms.get("dashed"), `${EX}some-prop`);
    assert.equal(terms.get("dotted"), `${EX}a.b`);
    assert.equal(
      terms.get("vocabRelative"),
      "https://vocab.example/#vocabRelative",
    );
    assert.equal(terms.get("chained"), `${EX}sub/x`);
    assert.equal(terms.get("absolute"), "https://other.example/#y");
  });

  it("leaves out keyword aliases and reverse properties", async () => {
    const terms = await parseContext({
      "@context": {
        ex: EX,
        id: "@id",
        type: "@type",
        children: { "@reverse": "ex:parent" },
      },
    });
    assert.deepEqual([...terms.keys()], ["ex"]);
  });

  it("processes the objects of an array in order without loading URLs", async () => {
    const terms = await parseContext({
      "@context": [
        "https://www.w3.org/ns/activitystreams",
        { ex: EX, term: "ex:first" },
        { term: "ex:second" },
      ],
    });
    assert.equal(terms.get("term"), `${EX}second`);
    assert.equal(terms.has("actor"), false);
  });

  it("removes the terms that a null resets", async () => {
    const terms = await parseContext({
      "@context": [{ before: `${EX}before` }, null, { after: `${EX}after` }],
    });
    assert.deepEqual(terms, new Map([["after", `${EX}after`]]));
  });

  it("rejects a document without a context object", async () => {
    await assert.rejects(
      parseContext({ "@context": "https://www.w3.org/ns/activitystreams" }),
      TypeError,
    );
    await assert.rejects(parseContext([]), TypeError);
  });
});

describe("resolveRange", () => {
  const resolve = resolveRange(
    new Map([
      ["Link", `${AS}Link`],
      ["xsd", XSD],
    ]),
  );

  it("resolves terms and compact IRIs through the context", () => {
    assert.equal(resolve("Link"), `${AS}Link`);
    assert.equal(resolve("xsd:dateTime"), `${XSD}dateTime`);
  });

  it("knows the rdf prefix without a context term", () => {
    assert.equal(
      resolve("rdf:langString"),
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString",
    );
  });

  it("resolves a range without an IRI to undefined", () => {
    assert.equal(resolve("MIME Media Type"), undefined);
    assert.equal(resolve("unknown:thing"), undefined);
  });
});

describe("parseNamespaceTerms", () => {
  it("lists the anchors of the property sections only", () => {
    const html = `
      <section id="class-definitions">
        <a id="Note" href="https://example.org/vocab#dfn-note">Note</a>
      </section>
      <section id="property-definitions">
        <p><a id="actor" href="https://example.org/vocab#dfn-actor">actor</a>
        <a href="https://example.org/vocab#dfn-none">no id</a></p>
      </section>
      <section id="extensions">
        <a id="sensitive" href="https://example.org/ext#sensitive">x</a>
      </section>`;
    assert.deepEqual(parseNamespaceTerms(html), [
      { term: "actor", definition: "https://example.org/vocab#dfn-actor" },
      { term: "sensitive", definition: "https://example.org/ext#sensitive" },
    ]);
  });
});

describe("parseAnchors", () => {
  it("collects every id attribute", () => {
    assert.deepEqual(
      parseAnchors(
        '<h2 id="a">A</h2><div><span id="b"></span></div><p id=""></p>',
      ),
      new Set(["a", "b"]),
    );
  });
});

const definitionTable = (
  anchor: string,
  iri: string,
  rows: readonly (readonly [string, string])[],
): string => `
  <table>
    <tr><td><dfn id="${anchor}">${anchor}</dfn></td>
      <td>URI:</td><td><code>${iri}</code></td></tr>
    ${rows.map(([label, value]) => `<tr><td>${label}:</td><td>${value}</td></tr>`).join("\n")}
  </table>`;

describe("parseVocabulary", () => {
  it("reads the notes, range, and functionality of a definition", () => {
    const html = definitionTable("dfn-href", `${AS}href`, [
      ["Notes", "The target\n  resource [<cite>RFC3987</cite>]."],
      ["Range", "xsd:anyURI | Link"],
      ["Functional", "True"],
    ]);
    assert.deepEqual(parseVocabulary(html).get(`${AS}href`), {
      anchor: "dfn-href",
      iri: `${AS}href`,
      notes: "The target resource [RFC3987].",
      range: ["xsd:anyURI", "Link"],
      functional: true,
    });
  });

  it("gives undefined notes and an empty range when they are missing", () => {
    const html = definitionTable("dfn-to", `${AS}to`, [["Notes", " "]]);
    const to = parseVocabulary(html).get(`${AS}to`);
    assert.equal(to?.notes, undefined);
    assert.deepEqual(to?.range, []);
    assert.equal(to?.functional, false);
  });

  it("splits a range only outside brackets, reading an ordered list as its members", () => {
    const html = definitionTable("dfn-items", `${AS}items`, [
      ["Range", "Object | Link | Ordered List of [ Object | Link ]"],
    ]);
    assert.deepEqual(parseVocabulary(html).get(`${AS}items`)?.range, [
      "Object",
      "Link",
      "Object",
      "Link",
    ]);
  });

  it("keeps the first definition of a URI", () => {
    const html = [
      definitionTable("dfn-first", `${AS}name`, [["Notes", "First."]]),
      definitionTable("dfn-second", `${AS}name`, [["Notes", "Second."]]),
    ].join("");
    assert.equal(parseVocabulary(html).get(`${AS}name`)?.anchor, "dfn-first");
  });
});

describe("parseActivityPub", () => {
  it("maps the anchors of definition list terms to their text", () => {
    const html = `
      <dl>
        <dt id="inbox"><code>inbox</code></dt>
        <dd>A reference to an
          [<cite>ActivityStreams</cite>] OrderedCollection.</dd>
        <dt id="orphan">orphan</dt>
        <dt id="">unnamed</dt>
        <dd>A term without an anchor.</dd>
      </dl>`;
    assert.deepEqual(
      parseActivityPub(html),
      new Map([
        [
          "inbox",
          {
            anchor: "inbox",
            term: "inbox",
            text: "A reference to an [ActivityStreams] OrderedCollection.",
          },
        ],
      ]),
    );
  });
});
