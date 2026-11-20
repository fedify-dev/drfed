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

import {
  ADDRESSING_PROPERTIES,
  type DocumentNode,
  type DocumentNodeKind,
  type FieldPath,
  type JsonValue,
  describeDocument,
} from "@drfed/models/document";

/**
 * The relations a document's own properties hold, which saved revisions
 * index at their root: who acts, what it acts on, and who it is attributed
 * to.
 */
export const RELATION_PROPERTIES = [
  "actor",
  "object",
  "target",
  "origin",
  "result",
  "instrument",
  "attributedTo",
] as const;

/** The standard name of a relation property. */
export type RelationProperty = (typeof RELATION_PROPERTIES)[number];

/** The standard name of an addressing property. */
export type RecipientProperty = (typeof ADDRESSING_PROPERTIES)[number];

/**
 * How a value names what it stands for: an IRI reference, an embedded
 * document, or an embedded `Link`.
 */
export type Representation = "reference" | "embedded" | "link";

/**
 * One vocabulary document of a saved document, the root or one embedded at
 * any depth, as {@link interpretDocument} reads it by meaning.
 */
export interface InterpretedNode {
  /** The source path of the document; `[]` is the root. */
  readonly path: FieldPath;
  /**
   * The standard name of the property that embeds the document, whatever
   * its source spelling; `null` for the root.
   */
  readonly property: string | null;
  /** The type IRI, such as `…/activitystreams#Note`. */
  readonly type: string;
  readonly kind: DocumentNodeKind;
  /**
   * The document's own `id`, or the `href` of a `Link`, with a compact IRI
   * expanded; `null` when it has none.
   */
  readonly iri: string | null;
  /** The document's JSON as saved, with everything it embeds. */
  readonly value: JsonValue;
  /**
   * The occurrences of its own relation properties, in the order of
   * {@link RELATION_PROPERTIES}, then of their source keys and values,
   * including duplicates.
   */
  readonly relations: readonly RelationOccurrence[];
  /**
   * The occurrences of its own addressing properties, in the order of
   * `ADDRESSING_PROPERTIES`, then of their source keys and values,
   * including duplicates and anonymous embedded recipients.
   */
  readonly addressing: readonly RecipientOccurrence[];
  /**
   * Its own custom extension properties, by their source keys, sorted, with
   * their values as saved.
   */
  readonly extensions: readonly {
    readonly key: string;
    readonly value: JsonValue;
  }[];
}

/** One value of a relation or addressing property. */
interface Occurrence {
  /** The source path of the value, including its list index if any. */
  readonly path: FieldPath;
  readonly representation: Representation;
  /**
   * A reference as resolved, an embedded document's `id`, or a `Link`'s
   * `href`; `null` for an anonymous embedded value.
   */
  readonly iri: string | null;
  /** The embedded document or `Link`; `null` for a reference. */
  readonly node: InterpretedNode | null;
}

/** One value of a relation property. */
export interface RelationOccurrence extends Occurrence {
  readonly property: RelationProperty;
}

/** One value of an addressing property. */
export interface RecipientOccurrence extends Occurrence {
  readonly property: RecipientProperty;
  /**
   * The index of the value in its source key's list, or 0 for a value
   * written alone.
   */
  readonly position: number;
}

const pathKey = (path: FieldPath): string => JSON.stringify(path);

/**
 * Reads the value at a source path.  Paths come from documents whose keys
 * may be spelled `__proto__`, so only own properties are read.
 * @returns The value, or `undefined` when nothing is there.
 */
export function valueAt(
  document: JsonValue,
  path: FieldPath,
): JsonValue | undefined {
  let value: JsonValue | undefined = document;
  for (const segment of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, segment)
    ) {
      return undefined;
    }
    value = (value as Record<string | number, JsonValue>)[segment];
  }
  return value;
}

// A document names itself by its id; a Link by its href.  A node's
// identifiers are its own values only.
const ownIri = (node: DocumentNode): string | null =>
  node.identifiers.find(
    ({ property }) => property === (node.kind === "link" ? "href" : "id"),
  )?.iri ?? null;

interface MutableNode extends InterpretedNode {
  relations: RelationOccurrence[];
  addressing: RecipientOccurrence[];
}

/**
 * Interprets a saved document by meaning, through `describeDocument()`, so
 * that aliases, full-IRI keys and compact IRIs read as the validator reads
 * them, never by key spelling.  The relations and recipients of every
 * vocabulary document are read, not only of the root: the `object` of a
 * `Like` embedded in an `Undo`, for one.  Saved indexes and read surfaces
 * share it, so that they cannot disagree about what a document says.
 *
 * A value of a relation or addressing property is a reference when it is an
 * IRI, or an embedded document or `Link`.  A `null` in a list, which names
 * nothing, is no occurrence, and positions in a list are kept as written.
 * @param document A saved document.
 * @returns The root and every embedded document in traversal order, or
 *          `null` when `describeDocument()` cannot read the document, that
 *          is, unless it validates without errors.
 */
export function interpretDocument(
  document: unknown,
): readonly InterpretedNode[] | null {
  const described = describeDocument(document);
  if (described == null || described.length === 0) return null;
  // Validation has accepted it as JSON.
  const json = document as JsonValue;
  const nodes = new Map<string, MutableNode>(
    described.map((node) => [
      pathKey(node.path),
      {
        path: node.path,
        property: node.property ?? null,
        type: node.type,
        kind: node.kind,
        iri: ownIri(node),
        value: valueAt(json, node.path) ?? null,
        relations: [],
        addressing: [],
        extensions: node.extensionProperties.map((key) => ({
          key,
          value: valueAt(json, [...node.path, key]) ?? null,
        })),
      },
    ]),
  );
  for (const node of described) {
    const interpreted = nodes.get(pathKey(node.path))!;
    const references = new Map(
      node.identifiers.map(({ path, iri }) => [pathKey(path), iri]),
    );
    const occurrences = (
      property: string,
    ): (Occurrence & { readonly position: number })[] =>
      (node.properties.get(property) ?? []).flatMap((source) => {
        const path = [...node.path, source];
        const value = valueAt(json, path);
        const entries: [FieldPath, number][] = Array.isArray(value)
          ? value.map((_, position) => [[...path, position], position])
          : value == null
            ? []
            : [[path, 0]];
        return entries.flatMap(
          ([entryPath, position]): (Occurrence & {
            readonly position: number;
          })[] => {
            const child = nodes.get(pathKey(entryPath));
            if (child != null) {
              return [
                {
                  path: entryPath,
                  position,
                  representation: child.kind === "link" ? "link" : "embedded",
                  iri: child.iri,
                  node: child,
                },
              ];
            }
            const iri = references.get(pathKey(entryPath));
            return iri == null
              ? []
              : [
                  {
                    path: entryPath,
                    position,
                    representation: "reference",
                    iri,
                    node: null,
                  },
                ];
          },
        );
      });
    for (const property of RELATION_PROPERTIES) {
      for (const { position: _, ...occurrence } of occurrences(property)) {
        interpreted.relations.push({ property, ...occurrence });
      }
    }
    for (const property of ADDRESSING_PROPERTIES) {
      for (const occurrence of occurrences(property)) {
        interpreted.addressing.push({ property, ...occurrence });
      }
    }
  }
  return [...nodes.values()];
}
