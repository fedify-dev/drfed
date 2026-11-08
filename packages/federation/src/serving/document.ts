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
  type ExtensionNode,
  type FieldPath,
  type JsonValue,
  describeDocument,
} from "@drfed/models/document";
import { PUBLIC_IRI } from "@drfed/models/resource";
import type { Context } from "@fedify/fedify";
import { Object as APObject } from "@fedify/vocab";

import type { JsonObject } from "../local-write/types.ts";

const ACTIVITY_STREAMS = "https://www.w3.org/ns/activitystreams";
/** The type IRI of `Create`, which has its own activity route. */
export const CREATE_TYPE = `${ACTIVITY_STREAMS}#Create`;
/** The type IRI of `Delete`, which outlives the object it deletes. */
export const DELETE_TYPE = `${ACTIVITY_STREAMS}#Delete`;
const BLIND_PROPERTIES = ["bto", "bcc"] as const;
const RECIPIENT_PROPERTIES: ReadonlySet<string> = new Set(
  ADDRESSING_PROPERTIES,
);

const pathKey = (path: FieldPath): string => JSON.stringify(path);

/** What serving reads of a described document or extension node object. */
type Described = Pick<DocumentNode | ExtensionNode, "path" | "identifiers">;

/**
 * Collects the blind addressing keys of each described document and
 * extension node object, whatever their spelling, by its source path.
 * @returns The keys to omit, by path.
 */
const blindKeys = (
  nodes: readonly Pick<DocumentNode | ExtensionNode, "path" | "properties">[],
): ReadonlyMap<string, ReadonlySet<string>> =>
  new Map(
    nodes.map((node) => [
      pathKey(node.path),
      new Set(
        BLIND_PROPERTIES.flatMap(
          (property) => node.properties.get(property) ?? [],
        ),
      ),
    ]),
  );

const omitKeys = (
  value: JsonValue,
  path: FieldPath,
  omitted: ReadonlyMap<string, ReadonlySet<string>>,
): JsonValue => {
  if (Array.isArray(value)) {
    return value.map((entry: JsonValue, index) =>
      omitKeys(entry, [...path, index], omitted),
    );
  }
  if (value === null || typeof value !== "object") return value;
  const keys = omitted.get(pathKey(path));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => keys?.has(key) !== true)
      .map(([key, entry]) => [key, omitKeys(entry, [...path, key], omitted)]),
  );
};

/**
 * States the context a document without `@context` is read with, the
 * ActivityStreams one, as Activity Streams 2.0 asks of documents it
 * produces.
 * @returns The document, with `@context` first if it had none.
 */
const statedContext = (document: JsonObject): JsonObject =>
  "@context" in document
    ? document
    : { "@context": ACTIVITY_STREAMS, ...document };

// An embedded document sits at [...parent, key] or [...parent, key, index].
const parentKey = (path: FieldPath): string | null =>
  path.length === 0
    ? null
    : pathKey(path.slice(0, typeof path.at(-1) === "number" ? -2 : -1));

/**
 * Reads a document's own IRI value of a functional property, such as its `id`
 * or `href`, written alone or as a singleton list.  A node's identifiers are
 * its own values only.
 * @returns The IRI with a compact IRI expanded, or `null` when there is none.
 */
const ownIdentifier = (node: Described, property: string): string | null =>
  node.identifiers.find((entry) => entry.property === property)?.iri ?? null;

const ownId = (node: Described): string | null => ownIdentifier(node, "id");

/** A document or node object as the one that embeds it reads it. */
interface Embedded {
  /** The source path of the document or node object that embeds it. */
  readonly parent: string | null;
  /** The standard name of the property that embeds it. */
  readonly property?: string | undefined;
  /** The IRI the addressing index records for it as a recipient. */
  readonly iri: string | null;
  /** The IRI it refers to as a `Link`, by its `href`. */
  readonly href: string | null;
}

const embeddedDocument = (node: DocumentNode): Embedded => {
  const href = node.kind === "link" ? ownIdentifier(node, "href") : null;
  return {
    parent: parentKey(node.path),
    property: node.property,
    iri: node.kind === "link" ? href : ownId(node),
    href,
  };
};

// A node object in an extension value is read as a recipient by its href
// when one of its types is a Link, and by its id otherwise.  Its href is a
// reference whatever its type, and its id is embedded.
const embeddedExtension = (node: ExtensionNode): Embedded => {
  const href = ownIdentifier(node, "href");
  return {
    parent: node.parent == null ? null : pathKey(node.parent),
    property: node.property,
    iri: node.kind === "link" ? href : ownId(node),
    href,
  };
};

/**
 * Reads a document's own recipients as the addressing index records those of
 * a saved document: references as resolved, embedded documents by `id`, and
 * `Link` values by `href`.  An anonymous embedded recipient names no IRI.
 * @param children The documents or node objects it embeds.
 * @returns The addressing property and IRI of each recipient.
 */
const recipients = (
  node: Described,
  children: readonly Embedded[],
): { readonly property: string; readonly iri: string | null }[] => [
  ...node.identifiers
    .filter(({ property }) => RECIPIENT_PROPERTIES.has(property))
    .map(({ property, iri }) => ({ property, iri })),
  ...children
    .filter(
      (child) =>
        child.property != null && RECIPIENT_PROPERTIES.has(child.property),
    )
    .map((child) => ({ property: child.property!, iri: child.iri })),
];

/**
 * Tells whether a document's own addressing names recipients but not the
 * public in `to` or `cc`, which restricts its content to them.  A document
 * without recipients of its own goes with the document that embeds it.
 * @param children The documents or node objects it embeds.
 * @returns Whether the document is restricted.
 */
const isRestricted = (
  node: Described,
  children: readonly Embedded[],
): boolean => {
  const named = recipients(node, children);
  return (
    named.length > 0 &&
    !named.some(
      ({ property, iri }) =>
        (property === "to" || property === "cc") && iri === PUBLIC_IRI,
    )
  );
};

/**
 * Reads the IRIs an activity's `object` refers to without embedding them, as
 * references or by the `href` of `Link` values, including that of a `Link`
 * the document embeds elsewhere with the `id` a reference names.
 * @param children The documents or node objects it embeds.
 * @param links The `href` of each `Link` in the document, by its `id`.
 * @returns The IRIs.
 */
const referredObjects = (
  node: Described,
  children: readonly Embedded[],
  links: ReadonlyMap<string, readonly string[]>,
): string[] => [
  ...node.identifiers
    .filter(({ property }) => property === "object")
    .flatMap(({ iri }) => [iri, ...(links.get(iri) ?? [])]),
  ...children
    .filter((child) => child.property === "object")
    .map(({ href }) => href)
    .filter((iri) => iri != null),
];

/** A saved document as it is served, and what its validator reading says. */
export interface ServedDocument {
  /** The type IRI, whatever key or term spells it. */
  readonly type: string;
  /** The `id` with a compact IRI expanded, whatever key spells it. */
  readonly id: string | null;
  /**
   * The document without blind recipients, stating the ActivityStreams
   * context if it had no `@context`.
   */
  readonly document: JsonObject;
}

/** What serving a saved document depends on besides the document itself. */
export interface DocumentInspection {
  readonly served: ServedDocument;
  /**
   * The `id` of every embedded document and extension node object, at any
   * depth.
   */
  readonly embedded: readonly string[];
  /**
   * The IRIs that the `object` of the root, of an embedded activity or of an
   * extension node object, unless it is a `Delete`, refers to without
   * embedding them, as references or `Link` values.
   */
  readonly objectReferences: readonly string[];
  /**
   * Whether an embedded document or extension node object, at any depth, is
   * addressed to recipients but not to the public, so that serving the root
   * publicly would expose it to others.
   */
  readonly restricted: boolean;
  /**
   * Whether the validator cannot read all of an extension node object, as
   * when it has a `@context` of its own, or two node objects share an `id`,
   * so that the recipients and references of what they describe cannot be
   * told from any one of them.
   */
  readonly uninterpreted: boolean;
}

/**
 * Reads a saved document once for serving.
 * @param document A saved document, with its blind recipients.
 * @returns The inspection, or `null` when the validator cannot read the
 *          document, which is then not served.
 */
export function inspectDocument(
  document: JsonObject,
): DocumentInspection | null {
  const nodes = describeDocument(document);
  const root = nodes?.[0];
  if (nodes == null || root == null) return null;
  const embedded = nodes.filter(
    ({ path, kind }) => path.length > 0 && kind !== "link",
  );
  const extensions = nodes.flatMap((node) => node.extensions);
  const byParent = Map.groupBy(
    [...nodes.map(embeddedDocument), ...extensions.map(embeddedExtension)],
    ({ parent }) => parent,
  );
  const children = (node: Described): readonly Embedded[] =>
    byParent.get(pathKey(node.path)) ?? [];
  const links = new Map(
    [
      ...Map.groupBy(
        [...nodes, ...extensions].flatMap((node) => {
          const id = ownId(node);
          const href = ownIdentifier(node, "href");
          return node.kind === "link" && id != null && href != null
            ? [{ id, href }]
            : [];
        }),
        ({ id }) => id,
      ),
    ].map(([id, entries]) => [id, entries.map(({ href }) => href)]),
  );
  // Node objects that share an id are one node, which no single one tells.
  const ids = [...nodes, ...extensions].map(ownId).filter((iri) => iri != null);
  return {
    served: {
      type: root.type,
      id: ownId(root),
      document: statedContext(
        omitKeys(
          document,
          [],
          blindKeys([...nodes, ...extensions]),
        ) as JsonObject,
      ),
    },
    embedded: [...embedded, ...extensions]
      .map(ownId)
      .filter((iri) => iri != null),
    // A node object in an extension value has no kind the validator reads.
    objectReferences: [
      ...nodes.filter(
        ({ kind, type }) => kind === "activity" && type !== DELETE_TYPE,
      ),
      ...extensions.filter(({ types }) => !types.includes(DELETE_TYPE)),
    ].flatMap((node) => referredObjects(node, children(node), links)),
    restricted: [...embedded, ...extensions].some((node) =>
      isRestricted(node, children(node)),
    ),
    uninterpreted:
      extensions.some(({ uninterpreted }) => uninterpreted) ||
      new Set(ids).size < ids.length,
  };
}

/**
 * Reads a saved document once for serving.  See {@link publicDocument}.
 * @param document A saved document, with its blind recipients.
 * @returns The served form, or `null` when the validator cannot read the
 *          document or its blind recipients cannot be found, so that it is
 *          not served.
 */
export function serveDocument(document: JsonObject): ServedDocument | null {
  const inspection = inspectDocument(document);
  return inspection == null || inspection.uninterpreted
    ? null
    : inspection.served;
}

/**
 * Removes blind recipients from a saved document for public or federated
 * output: the `bto` and `bcc` of the root, of every embedded document and of
 * every JSON-LD node object in extension values, read with the context it
 * inherits, found by meaning, so that aliases, full-IRI keys and compact IRI
 * keys are removed as well.  JSON literals stay as they are.  A document
 * without `@context` states the ActivityStreams context the validator read
 * it with.  Everything else, including the context, extension properties,
 * references, embedded values and the order of keys and values, stays as it
 * was saved.  The input is not changed.
 * @param document A saved document, with its blind recipients.
 * @returns A new document without them, or `null` when the validator cannot
 *          read the document offline, or when a node object in an extension
 *          value has a `@context` of its own, which the validator does not
 *          read; such a document is not served.
 */
export function publicDocument(document: JsonObject): JsonObject | null {
  return serveDocument(document)?.document ?? null;
}

/**
 * Parses a document into a Fedify vocabulary object with the context's
 * loaders.  Fedify keeps the parsed JSON-LD and returns it as the object's
 * representation, so the object keeps the document's context and extension
 * properties.  Fedify 2.4.3 cannot parse every document the validator
 * accepts, such as one with a `Link` in `audience` or `object`; federation
 * reads serve those without parsing them.  Nothing is dereferenced.  An object derived from
 * the result, as by `clone()`, loses that representation and is serialized
 * from the properties Fedify knows.  A document without `@context` is
 * parsed, and represented, with the ActivityStreams context.
 * @param ctx The Fedify context whose loaders resolve JSON-LD contexts.
 * @param document The document to parse, usually from {@link publicDocument}.
 * @returns The vocabulary object.
 * @throws {TypeError} If Fedify cannot parse the document.
 */
export async function parseVocab(
  ctx: Pick<Context<unknown>, "contextLoader" | "documentLoader">,
  document: JsonObject,
): Promise<APObject> {
  return await APObject.fromJsonLd(statedContext(document), {
    contextLoader: ctx.contextLoader,
    documentLoader: ctx.documentLoader,
  });
}
