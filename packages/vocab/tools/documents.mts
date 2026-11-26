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
 * Reads the property definitions out of the Activity Streams namespace
 * document, its JSON-LD context, the Activity Vocabulary, and ActivityPub.
 */
import { type DefaultTreeAdapterTypes, parse } from "parse5";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/** The sections of the namespace document that list property terms. */
const NAMESPACE_PROPERTY_SECTIONS: ReadonlySet<string> = new Set([
  "property-definitions",
  "extensions",
]);
const RDF_PREFIX = "rdf";
const RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const FUNCTIONAL = "True";
const RANGE_SEPARATOR = "|";
const ABSOLUTE_IRI = /^[a-z][a-z\d+.-]*:\/\//iu;
const COMPACT_IRI = /^(?<prefix>[a-z][\w-]*):(?<local>\w+)$/iu;
const FIELD_LABEL = /^(?<label>[A-Za-z ]+):$/u;

/** A property term that the namespace document lists. */
export interface NamespaceTerm {
  readonly term: string;
  /** The link to the term's definition. */
  readonly definition: string;
}

/** A property definition table of the Activity Vocabulary. */
export interface VocabularyDefinition {
  readonly anchor: string;
  readonly iri: string;
  readonly notes: string;
  /** The range as written, such as `Object` or `xsd:dateTime`. */
  readonly range: readonly string[];
  readonly functional: boolean;
}

/** A property definition list item of ActivityPub. */
export interface ActivityPubDefinition {
  readonly anchor: string;
  readonly term: string;
  readonly text: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isElement =
  (tagName: string) =>
  (node: Node): node is Element =>
    "tagName" in node && node.tagName === tagName;

const childrenOf = (node: Node): readonly Node[] =>
  "childNodes" in node ? node.childNodes : [];

const descendantsOf = (node: Node): readonly Node[] =>
  childrenOf(node).flatMap((child) => [child, ...descendantsOf(child)]);

const attributeOf = (element: Element, name: string): string | undefined =>
  element.attrs.find((attribute) => attribute.name === name)?.value;

const textOf = (node: Node): string =>
  "value" in node && node.nodeName === "#text"
    ? node.value
    : childrenOf(node).map(textOf).join("");

/**
 * Collapses whitespace and the spaces just inside brackets, so that text
 * rendered from markup such as `[<cite>BCP47</cite>]` compares equal to text
 * copied from the rendered page.
 * @returns The normalized text.
 */
export const normalizeText = (text: string): string =>
  text
    .replaceAll(/\s+/gu, " ")
    .replaceAll(/\[ /gu, "[")
    .replaceAll(/ \]/gu, "]")
    .trim();

const termIdOf = (definition: unknown): string | undefined =>
  typeof definition === "string"
    ? definition
    : isRecord(definition) && typeof definition["@id"] === "string"
      ? definition["@id"]
      : undefined;

/**
 * Maps every term of a JSON-LD context document to the IRI it expands to.
 * Keywords and terms aliasing keywords are left out.  An `@context` may be an
 * array, whose objects are merged in order; the remote contexts it names are
 * not loaded, so their terms are not included.
 * @returns The IRIs keyed by term.
 */
export const parseContext = (json: unknown): ReadonlyMap<string, string> => {
  const value = isRecord(json) ? json["@context"] : undefined;
  const objects = (Array.isArray(value) ? value : [value]).filter(isRecord);
  if (objects.length === 0) {
    throw new TypeError("The namespace context has no @context object.");
  }
  const context: Readonly<Record<string, unknown>> = Object.assign(
    {},
    ...objects,
  );
  const ids = Object.entries(context).flatMap(([term, definition]) => {
    const id = termIdOf(definition);
    return term.startsWith("@") || id === undefined || id.startsWith("@")
      ? []
      : [[term, id] as const];
  });
  const prefixes = new Map(ids.filter(([, id]) => ABSOLUTE_IRI.test(id)));
  const expand = (id: string): string => {
    const groups = COMPACT_IRI.exec(id)?.groups;
    const prefix = groups && prefixes.get(groups["prefix"]!);
    return prefix === undefined ? id : `${prefix}${groups!["local"]!}`;
  };
  return new Map(ids.map(([term, id]) => [term, expand(id)]));
};

/**
 * Resolves a range written in the Activity Vocabulary, such as `Link` or
 * `xsd:dateTime`, to an IRI through the namespace context.  A range without
 * an IRI, such as `MIME Media Type`, resolves to `undefined`.
 * @returns A function from a written range to its IRI.
 */
export const resolveRange =
  (terms: ReadonlyMap<string, string>) =>
  (range: string): string | undefined => {
    const groups = COMPACT_IRI.exec(range)?.groups;
    if (groups === undefined) return terms.get(range);
    const { prefix, local } = groups;
    const namespace =
      prefix === RDF_PREFIX ? RDF_NAMESPACE : terms.get(prefix!);
    return namespace === undefined ? undefined : `${namespace}${local!}`;
  };

const isInPropertySection = (ancestors: readonly Element[]): boolean =>
  ancestors.some(
    (element) =>
      element.tagName === "section" &&
      NAMESPACE_PROPERTY_SECTIONS.has(attributeOf(element, "id") ?? ""),
  );

const namespaceTermsIn = (
  node: Node,
  ancestors: readonly Element[],
): readonly NamespaceTerm[] => {
  const element = "tagName" in node ? node : undefined;
  const id = element && attributeOf(element, "id");
  const href = element && attributeOf(element, "href");
  const own =
    element?.tagName === "a" &&
    id !== undefined &&
    href !== undefined &&
    isInPropertySection(ancestors)
      ? [{ term: id, definition: href }]
      : [];
  const inner = element === undefined ? ancestors : [...ancestors, element];
  return [
    ...own,
    ...childrenOf(node).flatMap((child) => namespaceTermsIn(child, inner)),
  ];
};

/**
 * Lists the property terms of the namespace document with their links.
 * @returns The terms in document order.
 */
export const parseNamespaceTerms = (html: string): readonly NamespaceTerm[] =>
  namespaceTermsIn(parse(html), []);

/**
 * Lists the `id` attributes of an HTML document, which its links can point to
 * as fragments.
 * @returns The anchors of the document.
 */
export const parseAnchors = (html: string): ReadonlySet<string> =>
  new Set(
    descendantsOf(parse(html)).flatMap((node) => {
      const id = "tagName" in node ? attributeOf(node, "id") : undefined;
      return id === undefined ? [] : [id];
    }),
  );

const fieldsOf = (row: Element): readonly (readonly [string, string])[] => {
  const cells = row.childNodes.filter(isElement("td"));
  return cells.flatMap((cell, index) => {
    const label = FIELD_LABEL.exec(textOf(cell).trim())?.groups?.["label"];
    const value = cells[index + 1];
    return label === undefined || value === undefined
      ? []
      : [[label, normalizeText(textOf(value))] as const];
  });
};

const anchorOf = (row: Element): string | undefined => {
  const dfn = descendantsOf(row).find(isElement("dfn"));
  return dfn && attributeOf(dfn, "id");
};

interface Group {
  readonly anchor: string;
  readonly fields: ReadonlyMap<string, string>;
}

const groupRows = (
  groups: readonly Group[],
  row: Element,
): readonly Group[] => {
  const anchor = anchorOf(row);
  const fields = fieldsOf(row);
  if (anchor !== undefined) {
    return [...groups, { anchor, fields: new Map(fields) }];
  }
  const last = groups.at(-1);
  return last === undefined
    ? groups
    : [
        ...groups.slice(0, -1),
        { anchor: last.anchor, fields: new Map([...last.fields, ...fields]) },
      ];
};

const definitionOf = (group: Group): readonly VocabularyDefinition[] => {
  const iri = group.fields.get("URI");
  return iri === undefined
    ? []
    : [
        {
          anchor: group.anchor,
          iri,
          notes: group.fields.get("Notes") ?? "",
          range: (group.fields.get("Range") ?? "")
            .split(RANGE_SEPARATOR)
            .map((range) => range.trim())
            .filter((range) => range !== ""),
          functional: group.fields.get("Functional") === FUNCTIONAL,
        },
      ];
};

/**
 * Maps the URI of every term the Activity Vocabulary defines in a table to
 * its definition.  Where a URI is defined twice, the first definition wins.
 * @returns The definitions keyed by URI.
 */
export const parseVocabulary = (
  html: string,
): ReadonlyMap<string, VocabularyDefinition> => {
  const definitions = descendantsOf(parse(html))
    .filter(isElement("table"))
    .flatMap((table) =>
      descendantsOf(table)
        .filter(isElement("tr"))
        .reduce(groupRows, [])
        .flatMap(definitionOf),
    );
  return new Map(
    definitions.toReversed().map((definition) => [definition.iri, definition]),
  );
};

const nextElementOf = (
  siblings: readonly Node[],
  node: Node,
): Node | undefined =>
  siblings
    .slice(siblings.indexOf(node) + 1)
    .find((sibling) => "tagName" in sibling);

/**
 * Maps the anchor of every term ActivityPub defines in a list to it.
 * @returns The definitions keyed by anchor.
 */
export const parseActivityPub = (
  html: string,
): ReadonlyMap<string, ActivityPubDefinition> =>
  new Map(
    descendantsOf(parse(html))
      .filter(isElement("dl"))
      .flatMap((list) =>
        list.childNodes.filter(isElement("dt")).flatMap((term) => {
          const anchor = attributeOf(term, "id");
          const description = nextElementOf(list.childNodes, term);
          return anchor === undefined ||
            description === undefined ||
            !isElement("dd")(description)
            ? []
            : [
                [
                  anchor,
                  {
                    anchor,
                    term: normalizeText(textOf(term)),
                    text: normalizeText(textOf(description)),
                  },
                ] as const,
              ];
        }),
      ),
  );
