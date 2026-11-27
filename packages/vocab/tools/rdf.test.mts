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

import { parseRdf } from "./rdf.mts";

const EX = "https://example.org/ns#";
const BASE = "https://example.org/ns";

const TURTLE = `
@prefix ex: <${EX}> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix schema: <http://schema.org/> .
@prefix dcam: <http://purl.org/dc/dcam/> .

ex:single a rdf:Property, owl:FunctionalProperty ; rdfs:range ex:A .
ex:union a rdf:Property ; rdfs:range [ owl:unionOf ( ex:A ex:B ) ] .
ex:several a rdf:Property ; rdfs:range ex:A, ex:B .
ex:none a rdf:Property .
ex:suggested schema:rangeIncludes ex:A, ex:B ; dcam:rangeIncludes ex:C .
ex:both rdfs:range ex:A ; schema:rangeIncludes ex:B .
ex:repeated rdfs:range ex:A, ex:A .
ex:twoFirsts rdfs:range [ owl:unionOf _:twoFirsts ] .
_:twoFirsts rdf:first ex:A, ex:B ; rdf:rest rdf:nil .
ex:twoRests rdfs:range [ owl:unionOf _:twoRests ] .
_:twoRests rdf:first ex:A ; rdf:rest rdf:nil, _:twoRestsTail .
_:twoRestsTail rdf:first ex:B ; rdf:rest rdf:nil .
ex:twoUnions rdfs:range _:twoUnions .
_:twoUnions owl:unionOf ( ex:A ex:B ), ( ex:C ) .
`;

describe("parseRdf", () => {
  it("reads a single range and functionality from Turtle", async () => {
    const definitionOf = await parseRdf(TURTLE, "turtle", BASE);
    assert.deepEqual(definitionOf(`${EX}single`), {
      range: [`${EX}A`],
      rangeDeclared: true,
      functional: true,
    });
  });

  it("reads an owl:unionOf range as its members", async () => {
    const definitionOf = await parseRdf(TURTLE, "turtle", BASE);
    assert.deepEqual(definitionOf(`${EX}union`)?.range, [`${EX}A`, `${EX}B`]);
  });

  it("gives no range for several ranges or none", async () => {
    const definitionOf = await parseRdf(TURTLE, "turtle", BASE);
    assert.deepEqual(definitionOf(`${EX}several`), {
      range: undefined,
      rangeDeclared: true,
      functional: false,
    });
    assert.deepEqual(definitionOf(`${EX}none`), {
      range: undefined,
      rangeDeclared: false,
      functional: false,
    });
  });

  it("counts a repeated rdfs:range once", async () => {
    const definitionOf = await parseRdf(TURTLE, "turtle", BASE);
    assert.deepEqual(definitionOf(`${EX}repeated`)?.range, [`${EX}A`]);
  });

  it("gives no range for a union that is not one list", async () => {
    const definitionOf = await parseRdf(TURTLE, "turtle", BASE);
    for (const name of ["twoFirsts", "twoRests", "twoUnions"]) {
      assert.deepEqual(
        definitionOf(`${EX}${name}`),
        { range: undefined, rangeDeclared: true, functional: false },
        name,
      );
    }
  });

  it("reads every suggested type without an rdfs:range", async () => {
    const definitionOf = await parseRdf(TURTLE, "turtle", BASE);
    assert.deepEqual(
      new Set(definitionOf(`${EX}suggested`)?.range),
      new Set([`${EX}A`, `${EX}B`, `${EX}C`]),
    );
  });

  it("prefers an rdfs:range to a suggested type", async () => {
    const definitionOf = await parseRdf(TURTLE, "turtle", BASE);
    assert.deepEqual(definitionOf(`${EX}both`)?.range, [`${EX}A`]);
  });

  it("reads schema.org's rangeIncludes from JSON-LD", async () => {
    const document = JSON.stringify({
      "@context": { schema: "http://schema.org/" },
      "@graph": [
        {
          "@id": "schema:inLanguage",
          "schema:rangeIncludes": [
            { "@id": "schema:Language" },
            { "@id": "schema:Text" },
          ],
        },
      ],
    });
    const definitionOf = await parseRdf(document, "json-ld", BASE);
    assert.deepEqual(
      new Set(definitionOf("http://schema.org/inLanguage")?.range),
      new Set(["http://schema.org/Language", "http://schema.org/Text"]),
    );
  });

  it("gives undefined for an IRI the vocabulary does not define", async () => {
    const definitionOf = await parseRdf(TURTLE, "turtle", BASE);
    assert.equal(definitionOf(`${EX}missing`), undefined);
  });

  it("reads JSON-LD", async () => {
    const document = JSON.stringify({
      "@context": {
        ex: EX,
        rdfs: "http://www.w3.org/2000/01/rdf-schema#",
        "rdfs:range": { "@type": "@id" },
      },
      "@graph": [{ "@id": "ex:p", "rdfs:range": "ex:A" }],
    });
    const definitionOf = await parseRdf(document, "json-ld", BASE);
    assert.deepEqual(definitionOf(`${EX}p`)?.range, [`${EX}A`]);
  });

  it("refuses to load a remote context", async () => {
    const document = JSON.stringify({
      "@context": "https://example.org/context.jsonld",
      "@id": "ex:p",
    });
    await assert.rejects(parseRdf(document, "json-ld", BASE));
  });
});
