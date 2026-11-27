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
 * Reads the terms an RDF vocabulary document defines, written in JSON-LD or
 * Turtle, with the range and functionality it declares for each.
 */
import jsonld from "@fedify/vocab-runtime/jsonld";
import { Parser, type Quad, type Term } from "n3";

/** The serialization of an RDF vocabulary document. */
export type RdfFormat = "json-ld" | "turtle";

/** What an RDF vocabulary declares about one term. */
export interface RdfDefinition {
  /**
   * The IRIs of the types a value is one of.  They are those of the single
   * `rdfs:range` the vocabulary declares, with an `owl:unionOf` read as its
   * members.  Without an `rdfs:range`, they are every type that
   * `schema:rangeIncludes` or `dcam:rangeIncludes` suggests, which schema.org
   * and Dublin Core declare instead.  `undefined` when the vocabulary
   * declares none of them, several `rdfs:range`s, or a range that is not a
   * class IRI or a union of them.
   */
  readonly range: readonly string[] | undefined;
  /**
   * Whether the vocabulary declares or suggests any range at all, so that an
   * undefined `range` with it means one that cannot be read.
   */
  readonly rangeDeclared: boolean;
  /** Whether the term is an `owl:FunctionalProperty`. */
  readonly functional: boolean;
}

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const RDFS_RANGE = `${RDFS}range`;
/**
 * The predicates that suggest a type a value is one of, one triple per type:
 * schema.org's in both of its namespaces, and Dublin Core's.
 */
const RANGE_INCLUDES: readonly string[] = [
  "http://schema.org/rangeIncludes",
  "https://schema.org/rangeIncludes",
  "http://purl.org/dc/dcam/rangeIncludes",
];
const OWL_UNION_OF = `${OWL}unionOf`;
const OWL_FUNCTIONAL_PROPERTY = `${OWL}FunctionalProperty`;
const N_QUADS = "application/n-quads";

/**
 * A JSON-LD document loader that loads nothing.  A namespace's documents
 * must be self-contained, so that the check reads only the documents its
 * namespace names.
 * @returns A rejected promise.
 */
export const refuseRemoteContext = (url: string): Promise<never> =>
  Promise.reject(new Error(`The remote context ${url} is not loaded.`));

const quadsOf = async (
  text: string,
  format: RdfFormat,
  base: string,
): Promise<readonly Quad[]> => {
  if (format === "turtle") {
    return new Parser({ baseIRI: base, format: "text/turtle" }).parse(text);
  }
  const nQuads: unknown = await jsonld.toRDF(JSON.parse(text), {
    base,
    format: N_QUADS,
    documentLoader: refuseRemoteContext,
  });
  if (typeof nQuads !== "string") {
    throw new TypeError(`${base} did not convert to N-Quads.`);
  }
  return new Parser({ format: "N-Quads" }).parse(nQuads);
};

const keyOf = (term: Term): string => `${term.termType} ${term.value}`;

const indexBySubject = (
  quads: readonly Quad[],
): ReadonlyMap<string, readonly Quad[]> =>
  Map.groupBy(quads, (quad) => keyOf(quad.subject));

/**
 * Parses an RDF vocabulary document.
 * @returns A function that looks up the definition of an IRI, which is
 * `undefined` when no statement has the IRI as its subject.
 */
export const parseRdf = async (
  text: string,
  format: RdfFormat,
  base: string,
): Promise<(iri: string) => RdfDefinition | undefined> => {
  const index = indexBySubject(await quadsOf(text, format, base));
  const objectsOf = (subject: Term, predicate: string): readonly Term[] =>
    (index.get(keyOf(subject)) ?? [])
      .filter((quad) => quad.predicate.value === predicate)
      .map((quad) => quad.object);
  const listOf = (node: Term | undefined): readonly Term[] | undefined => {
    if (node === undefined) return undefined;
    if (node.termType === "NamedNode" && node.value === RDF_NIL) return [];
    const [first] = objectsOf(node, RDF_FIRST);
    const rest = listOf(objectsOf(node, RDF_REST)[0]);
    return first === undefined || rest === undefined
      ? undefined
      : [first, ...rest];
  };
  const classesOf = (range: Term): readonly Term[] | undefined =>
    range.termType === "NamedNode"
      ? [range]
      : range.termType === "BlankNode"
        ? listOf(objectsOf(range, OWL_UNION_OF)[0])
        : undefined;
  const iris = (terms: readonly Term[] | undefined) =>
    terms !== undefined &&
    terms.length > 0 &&
    terms.every((term) => term.termType === "NamedNode")
      ? [...new Set(terms.map((term) => term.value))]
      : undefined;
  // An `rdfs:range` states what every value is, and wins over a suggestion.
  const rangeOf = (subject: Term): readonly string[] | undefined => {
    const ranges = objectsOf(subject, RDFS_RANGE);
    if (ranges.length > 0) {
      return ranges.length === 1 ? iris(classesOf(ranges[0]!)) : undefined;
    }
    return iris(
      RANGE_INCLUDES.flatMap((predicate) => objectsOf(subject, predicate)),
    );
  };
  return (iri) => {
    const quads = index.get(`NamedNode ${iri}`);
    if (quads === undefined) return undefined;
    const { subject } = quads[0]!;
    return {
      range: rangeOf(subject),
      rangeDeclared: [RDFS_RANGE, ...RANGE_INCLUDES].some(
        (predicate) => objectsOf(subject, predicate).length > 0,
      ),
      functional: objectsOf(subject, RDF_TYPE).some(
        (type) => type.value === OWL_FUNCTIONAL_PROPERTY,
      ),
    };
  };
};
