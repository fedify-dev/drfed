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
 * Reads the known property catalog, and rewrites fields of its entries in
 * place.  An update replaces only the lines of the fields it changes, so that
 * the comments, quoting, and wrapping of everything else stay as written.
 */
import {
  type Node,
  type Pair,
  type YAMLMap,
  isMap,
  isScalar,
  parse,
  parseDocument,
} from "yaml";

import type { CatalogEntry, Expectation } from "./namespace.mts";

/** The order of an entry's fields, which new fields are inserted in. */
const FIELD_ORDER = [
  "label",
  "description",
  "range",
  "multiple",
  "source",
] as const;
const LINE_WIDTH = 80;
const INDENT = "  ";

type Field = keyof Expectation;

/** A replacement of the text between two offsets. */
interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** Orders the insertions at the same offset by field. */
  readonly order: number;
}

/**
 * Parses the catalog.
 * @returns The entries, keyed by IRI, in catalog order.
 */
export const parseCatalog = (
  text: string,
): ReadonlyMap<string, CatalogEntry> => {
  const data: unknown = parse(text, { uniqueKeys: true });
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TypeError("The catalog is not a mapping.");
  }
  return new Map(Object.entries(data as Record<string, CatalogEntry>));
};

const rangeOf = (node: Node | null | undefined): readonly number[] => {
  const range = node?.range;
  if (range == null) throw new Error("A catalog node has no source range.");
  return range;
};

const lineStartOf = (text: string, offset: number): number =>
  text.lastIndexOf("\n", offset - 1) + 1;

const indentOf = (text: string, node: Node | null | undefined): string => {
  const start = rangeOf(node)[0]!;
  return " ".repeat(start - lineStartOf(text, start));
};

const pairOf = (map: YAMLMap, key: string): Pair<Node, Node> | undefined =>
  (map.items as Pair<Node, Node>[]).find(
    (pair) => isScalar(pair.key) && pair.key.value === key,
  );

// The lines a pair takes up, from the start of its key's line to the end of
// its value, including the final line break.
const spanOf = (
  text: string,
  pair: Pair<Node, Node>,
): { readonly start: number; readonly end: number } => ({
  start: lineStartOf(text, rangeOf(pair.key)[0]!),
  end: rangeOf(pair.value)[2]!,
});

const foldLines = (value: string, width: number): readonly string[] =>
  value.split(" ").reduce<readonly string[]>((lines, word) => {
    const last = lines.at(-1);
    return last !== undefined && `${last} ${word}`.length <= width
      ? [...lines.slice(0, -1), `${last} ${word}`]
      : [...lines, word];
  }, []);

const renderFolded = (key: string, value: string, indent: string): string =>
  `${indent}${key}: >-\n${foldLines(
    value,
    LINE_WIDTH - indent.length - INDENT.length,
  )
    .map((line) => `${indent}${INDENT}${line}\n`)
    .join("")}`;

const renderField = (
  field: Exclude<Field, "description">,
  value: Expectation[Field],
  indent: string,
): string =>
  field === "range"
    ? (value as readonly string[]).length === 0
      ? ""
      : `${indent}range:\n${(value as readonly string[])
          .map((iri) => `${indent}${INDENT}- ${JSON.stringify(iri)}\n`)
          .join("")}`
    : `${indent}${field}: ${JSON.stringify(value)}\n`;

const descriptionEdit = (text: string, entry: YAMLMap, value: string): Edit => {
  const description = pairOf(entry, "description")?.value;
  const english = isMap(description) ? pairOf(description, "en") : undefined;
  if (english === undefined) {
    throw new Error("A catalog entry has no English description.");
  }
  return {
    ...spanOf(text, english),
    text: renderFolded("en", value, indentOf(text, english.key)),
    order: FIELD_ORDER.indexOf("description"),
  };
};

const fieldEdit = (
  text: string,
  entry: YAMLMap,
  field: Exclude<Field, "description">,
  value: Expectation[Field],
): readonly Edit[] => {
  const order = FIELD_ORDER.indexOf(field);
  const pairs = entry.items as Pair<Node, Node>[];
  const indent = indentOf(text, pairs[0]?.key);
  const rendered = renderField(field, value, indent);
  const existing = pairOf(entry, field);
  if (existing !== undefined) {
    return [{ ...spanOf(text, existing), text: rendered, order }];
  }
  if (rendered === "") return [];
  const next = pairs.find(
    (pair) =>
      isScalar(pair.key) &&
      FIELD_ORDER.indexOf(pair.key.value as (typeof FIELD_ORDER)[number]) >
        order,
  );
  const at =
    next === undefined
      ? spanOf(text, pairs.at(-1)!).end
      : spanOf(text, next).start;
  return [{ start: at, end: at, text: rendered, order }];
};

const entryEdits = (
  text: string,
  entry: YAMLMap,
  fields: Expectation,
): readonly Edit[] =>
  Object.entries(fields).flatMap(([field, value]) =>
    field === "description"
      ? [descriptionEdit(text, entry, value as string)]
      : fieldEdit(
          text,
          entry,
          field as Exclude<Field, "description">,
          value as Expectation[Field],
        ),
  );

/**
 * Writes field values into the catalog's entries.  A field that an entry
 * does not have is inserted in the usual field order, and an empty `range`
 * removes the field.
 * @returns The rewritten catalog.
 */
export const updateCatalog = (
  text: string,
  updates: ReadonlyMap<string, Expectation>,
): string => {
  const root = parseDocument(text, { uniqueKeys: true }).contents;
  if (!isMap(root)) throw new TypeError("The catalog is not a mapping.");
  const edits = [...updates].flatMap(([iri, fields]) => {
    const entry = pairOf(root, iri)?.value;
    if (!isMap(entry)) throw new Error(`The catalog has no entry ${iri}.`);
    return entryEdits(text, entry, fields);
  });
  return edits
    .toSorted(
      (left, right) => right.start - left.start || right.order - left.order,
    )
    .reduce(
      (result, edit) =>
        `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`,
      text,
    );
};
