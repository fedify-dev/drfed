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
 * The shape of a namespace, and the kinds of namespace that read what it
 * publishes: a JSON-LD context, an RDF vocabulary, or an HTML document whose
 * anchors define the terms.  A namespace tells, for each entry it covers,
 * which field values its documents give and what is wrong beyond them; the
 * check reports the fields that differ, and the update writes them.
 */
import {
  collapseWhitespace,
  normalizeText,
  parseAnchors,
  parseContext,
} from "./documents.mts";
import { type RdfFormat, parseRdf } from "./rdf.mts";

export const JSON_LD = "application/ld+json";
export const HTML = "text/html";
export const TURTLE = "text/turtle";

/** The fields of a catalog entry that namespaces give values for. */
export interface CatalogEntry {
  readonly description: { readonly en: string };
  readonly range?: readonly string[];
  readonly multiple?: boolean;
  readonly source: string;
}

/**
 * The field values a namespace gives for an entry.  A field left out is one
 * the namespace says nothing about.  An empty `range` means the entry must
 * have none.
 */
export interface Expectation {
  /** The English description. */
  readonly description?: string;
  readonly range?: readonly string[];
  readonly multiple?: boolean;
  readonly source?: string;
}

/** What a namespace finds about one entry. */
export interface Finding {
  /** Where the values come from, as reports name it. */
  readonly origin: string;
  /** The field values the namespace gives. */
  readonly expected: Expectation;
  /** What is wrong with the entry that no field value can fix. */
  readonly problems: readonly string[];
}

/** A document that a namespace reads. */
export interface DocumentRequest {
  readonly url: string;
  /** The `Accept` header, which selects the representation to read. */
  readonly accept: string;
}

/** A namespace whose published definitions the catalog follows. */
export interface Namespace {
  /** The name in reports, such as `GoToSocial`. */
  readonly name: string;
  /** The documents to fetch, keyed by the name `find` reads them by. */
  readonly documents: Readonly<Record<string, DocumentRequest>>;
  /** Tells whether the namespace gives findings about an entry. */
  readonly covers: (iri: string, entry: CatalogEntry) => boolean;
  /** Reads the fetched documents and finds about each covered entry. */
  readonly find: (
    entries: ReadonlyMap<string, CatalogEntry>,
    documents: ReadonlyMap<string, string>,
  ) => ReadonlyMap<string, Finding> | Promise<ReadonlyMap<string, Finding>>;
}

/** What every generic kind of namespace needs to know. */
export interface NamespaceOptions {
  readonly name: string;
  /** The IRI prefix of the terms, such as `https://gotosocial.org/ns#`. */
  readonly iri: string;
  /** The document that publishes the definitions. */
  readonly url: string;
}

/**
 * Identifies the document a link points into, ignoring its fragment and a
 * trailing slash, which namespace documents and the catalog spell
 * differently.
 * @returns The link without its fragment and trailing slash.
 */
export const documentOf = (link: string): string => {
  const url = new URL(link);
  url.hash = "";
  return url.href.replace(/\/$/u, "");
};

/**
 * Reads the fragment of a link.
 * @returns The decoded fragment, without `#`.
 */
export const fragmentOf = (link: string): string =>
  decodeURIComponent(new URL(link).hash.slice(1));

/**
 * Formats a value for a report.
 * @returns The value as JSON.
 */
export const quote = (value: unknown): string => JSON.stringify(value);

/**
 * Compares two lists of IRIs regardless of their order.
 * @returns Whether both hold the same IRIs.
 */
export const sameSet = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const expected = new Set(right);
  return (
    new Set(left).size === expected.size &&
    left.every((item) => expected.has(item))
  );
};

/**
 * Selects the entries whose IRI begins with a namespace's prefix.
 * @returns A `covers` function.
 */
export const under =
  (prefix: string): Namespace["covers"] =>
  (iri) =>
    iri.startsWith(prefix);

/**
 * Reads a fetched document by the name a namespace gave it.
 * @returns The document's text.
 */
export const documentNamed = (
  documents: ReadonlyMap<string, string>,
  name: string,
): string => {
  const text = documents.get(name);
  if (text === undefined) throw new Error(`No document is named ${name}.`);
  return text;
};

/**
 * Finds about each entry with the same function.
 * @returns The findings, keyed by IRI.
 */
export const findingsOf = (
  entries: ReadonlyMap<string, CatalogEntry>,
  findingOf: (iri: string, entry: CatalogEntry) => Finding,
): ReadonlyMap<string, Finding> =>
  new Map([...entries].map(([iri, entry]) => [iri, findingOf(iri, entry)]));

// The value of each field that comparisons read off an entry.  A
// description keeps its brackets as written, so that a stray space inside
// one, which `normalizeText` drops from a namespace's text, differs.
const VALUE_OF: Readonly<
  Record<keyof Expectation, (entry: CatalogEntry) => unknown>
> = {
  description: (entry) => collapseWhitespace(entry.description.en),
  range: (entry) => entry.range ?? [],
  multiple: (entry) => entry.multiple,
  source: (entry) => entry.source,
};

// The form in which each field's value given by a namespace is written.
const EXPECTED_OF: Readonly<
  Record<keyof Expectation, (value: unknown) => unknown>
> = {
  description: (value) => normalizeText(value as string),
  range: (value) => value,
  multiple: (value) => value,
  source: (value) => value,
};

const SAME_VALUE: Readonly<
  Record<keyof Expectation, (left: unknown, right: unknown) => boolean>
> = {
  description: (left, right) => left === right,
  range: (left, right) =>
    sameSet(left as readonly string[], right as readonly string[]),
  multiple: (left, right) => left === right,
  source: (left, right) => left === right,
};

/**
 * Compares two values that namespaces give for the same field, by the rule
 * that {@link differencesOf} compares an entry's value by: descriptions with
 * their whitespace normalized, and ranges regardless of their order.
 * @returns Whether the values are the same.
 */
export const sameValue = (
  field: keyof Expectation,
  left: unknown,
  right: unknown,
): boolean =>
  SAME_VALUE[field](EXPECTED_OF[field](left), EXPECTED_OF[field](right));

/**
 * Selects the fields whose expected values the entry does not have.
 * Descriptions are compared with their whitespace collapsed, and an expected
 * description also without the spaces just inside its brackets, which is how
 * it is written; ranges are compared regardless of their order.
 * @returns The expected values of the differing fields, as they are written.
 */
export const differencesOf = (
  entry: CatalogEntry,
  expected: Expectation,
): Expectation =>
  Object.fromEntries(
    Object.entries(expected).flatMap(([name, value]) => {
      const field = name as keyof Expectation;
      if (value === undefined) return [];
      const written = EXPECTED_OF[field](value);
      return SAME_VALUE[field](VALUE_OF[field](entry), written)
        ? []
        : [[field, written] as const];
    }),
  );

/**
 * Describes how an entry differs from a finding, for a report.
 * @returns The finding's problems, then one message per differing field.
 */
export const messagesOf = (
  entry: CatalogEntry,
  finding: Finding,
): readonly string[] => [
  ...finding.problems,
  ...Object.entries(differencesOf(entry, finding.expected)).map(
    ([field, value]) =>
      `${field} is ${quote(VALUE_OF[field as keyof Expectation](entry))}, but ${finding.origin} gives ${quote(value)}`,
  ),
];

/**
 * Finds whether a term of the namespace's JSON-LD context expands to the IRI
 * of every entry under the namespace.  A context declares no range or
 * multiplicity, so it gives no field values.
 * @returns The namespace.
 */
export const contextNamespace = ({
  name,
  iri,
  url,
}: NamespaceOptions): Namespace => ({
  name,
  documents: { context: { url, accept: JSON_LD } },
  covers: under(iri),
  find: async (entries, documents) => {
    const defined = new Set(
      (
        await parseContext(JSON.parse(documentNamed(documents, "context")))
      ).values(),
    );
    return findingsOf(entries, (key) => ({
      origin: url,
      expected: {},
      problems: defined.has(key)
        ? []
        : [`no term of the context at ${url} expands to it`],
    }));
  },
});

const ACCEPT_OF: Readonly<Record<RdfFormat, string>> = {
  "json-ld": JSON_LD,
  turtle: TURTLE,
};

/**
 * The fields of an entry that a definition other than the vocabulary gives,
 * so that the vocabulary need not declare them.
 */
export type DefinedElsewhere = Readonly<
  Record<string, readonly ("range" | "multiple")[]>
>;

/**
 * Finds whether the namespace's RDF vocabulary defines the IRI of every
 * entry under the namespace.  Where the vocabulary declares an `rdfs:range`,
 * or suggests types with `schema:rangeIncludes` or `dcam:rangeIncludes`, it
 * gives `range`, and where it declares an `owl:FunctionalProperty`, it
 * gives `multiple: false`.  It reports a range it cannot read, and a `range`
 * or `multiple: false` of an entry that the vocabulary does not declare,
 * unless `definedElsewhere` lists that field for the entry's IRI; it never
 * proposes removing them, so that a person decides.
 * @returns The namespace.
 */
export const rdfNamespace = ({
  name,
  iri,
  url,
  format,
  definedElsewhere = {},
}: NamespaceOptions & {
  readonly format: RdfFormat;
  readonly definedElsewhere?: DefinedElsewhere;
}): Namespace => ({
  name,
  documents: { vocabulary: { url, accept: ACCEPT_OF[format] } },
  covers: under(iri),
  find: async (entries, documents) => {
    const definitionOf = await parseRdf(
      documentNamed(documents, "vocabulary"),
      format,
      url,
    );
    return findingsOf(entries, (key, entry) => {
      const definition = definitionOf(key);
      if (definition === undefined) {
        return {
          origin: url,
          expected: {},
          problems: [`${url} does not define it`],
        };
      }
      const elsewhere = new Set(definedElsewhere[key] ?? []);
      return {
        origin: url,
        expected: {
          ...(definition.range === undefined
            ? {}
            : { range: definition.range }),
          ...(definition.functional ? { multiple: false } : {}),
        },
        problems: [
          ...(definition.rangeDeclared && definition.range === undefined
            ? [
                `${url} declares a range that is not one class IRI or a union of them, so range is not checked`,
              ]
            : []),
          ...(!definition.rangeDeclared &&
          entry.range !== undefined &&
          !elsewhere.has("range")
            ? [`range is ${quote(entry.range)}, but ${url} declares none`]
            : []),
          ...(!definition.functional &&
          entry.multiple === false &&
          !elsewhere.has("multiple")
            ? [`multiple is false, but ${url} does not declare it functional`]
            : []),
        ],
      };
    });
  },
});

/**
 * Finds whether the `source` of every entry under the namespace points to an
 * anchor of the namespace's HTML document, for a namespace that documents
 * its terms in prose rather than in a machine-readable definition.  It gives
 * no field values.
 * @returns The namespace.
 */
export const anchorNamespace = ({
  name,
  iri,
  url,
}: NamespaceOptions): Namespace => ({
  name,
  documents: { page: { url, accept: HTML } },
  covers: under(iri),
  find: (entries, documents) => {
    const anchors = parseAnchors(documentNamed(documents, "page"));
    return findingsOf(entries, (_, entry) => {
      const fragment = fragmentOf(entry.source);
      return {
        origin: url,
        expected: {},
        problems:
          documentOf(entry.source) !== documentOf(url)
            ? [`source is not in ${url}`]
            : fragment === ""
              ? ["source has no fragment"]
              : anchors.has(fragment)
                ? []
                : [`${url} has no anchor #${fragment}`],
      };
    });
  },
});
