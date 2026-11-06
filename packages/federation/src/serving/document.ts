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
  type DocumentNode,
  type ExtensionNode,
  type FieldPath,
  type JsonValue,
  addressingProperties,
  describeDocument,
} from "@drfed/models/document";
import { PUBLIC_IRI } from "@drfed/models/resource";
import type { Context } from "@fedify/fedify";
import { Object as APObject } from "@fedify/vocab";

import type { JsonObject } from "../local-write/types.ts";

const activityStreams = "https://www.w3.org/ns/activitystreams";
/** The type IRI of `Create`, which has its own activity route. */
export const createType = `${activityStreams}#Create`;
/** The type IRI of `Delete`, which outlives the object it deletes. */
export const deleteType = `${activityStreams}#Delete`;
const blindProperties = ["bto", "bcc"] as const;
const recipientProperties: ReadonlySet<string> = new Set(addressingProperties);

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
        blindProperties.flatMap(
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
    : { "@context": activityStreams, ...document };

// An embedded document sits at [...parent, key] or [...parent, key, index];
// one at [...parent, key, key] is embedded in another embedded document.
const isChild = (child: FieldPath, parent: FieldPath): boolean =>
  parent.every((step, index) => child[index] === step) &&
  typeof child[parent.length] === "string" &&
  (child.length === parent.length + 1 ||
    (child.length === parent.length + 2 &&
      typeof child[parent.length + 1] === "number"));

/**
 * Reads a document's own IRI value of a functional property, such as its `id`
 * or `href`, written alone or as a singleton list.  A node's identifiers are
 * its own values only.
 * @returns The IRI with a compact IRI expanded, or `null` when there is none.
 */
const ownIdentifier = (node: Described, property: string): string | null =>
  node.identifiers.find((entry) => entry.property === property)?.iri ?? null;

/** A document or node object that another one embeds, as a recipient. */
interface Embedded {
  readonly path: FieldPath;
  readonly property?: string | undefined;
  /** The IRI the addressing index records for it as a recipient. */
  readonly iri: string | null;
}

/**
 * Reads a document's own recipients as the addressing index records those of
 * a saved document: references as resolved, embedded documents by `id`, and
 * `Link` values by `href`.  An anonymous embedded recipient names no IRI.
 * @param embedded The documents or node objects that may embed recipients.
 * @returns The addressing property and IRI of each recipient.
 */
const recipients = (
  node: Described,
  embedded: readonly Embedded[],
): { readonly property: string; readonly iri: string | null }[] => [
  ...node.identifiers
    .filter(({ property }) => recipientProperties.has(property))
    .map(({ property, iri }) => ({ property, iri })),
  ...embedded
    .filter(
      (child) =>
        child.property != null &&
        recipientProperties.has(child.property) &&
        isChild(child.path, node.path),
    )
    .map((child) => ({ property: child.property!, iri: child.iri })),
];

/**
 * Tells whether a document's own addressing names recipients but not the
 * public in `to` or `cc`, which restricts its content to them.  A document
 * without recipients of its own goes with the document that embeds it.
 * @returns Whether the document is restricted.
 */
const isRestricted = (
  node: Described,
  embedded: readonly Embedded[],
): boolean => {
  const named = recipients(node, embedded);
  return (
    named.length > 0 &&
    !named.some(
      ({ property, iri }) =>
        (property === "to" || property === "cc") && iri === PUBLIC_IRI,
    )
  );
};

const ownId = (node: Described): string | null => ownIdentifier(node, "id");

/**
 * Reads the IRIs an activity's `object` refers to without embedding them, as
 * references or by the `href` of `Link` values.
 * @returns The IRIs.
 */
const referredObjects = (
  node: DocumentNode,
  nodes: readonly DocumentNode[],
): string[] => [
  ...node.identifiers
    .filter(({ property }) => property === "object")
    .map(({ iri }) => iri),
  ...nodes
    .filter(
      (child) =>
        child.property === "object" &&
        child.kind === "link" &&
        isChild(child.path, node.path),
    )
    .map((child) => ownIdentifier(child, "href"))
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
   * The IRIs that the `object` of the root or of an embedded activity, unless
   * it is a `Delete`, refers to without embedding them, as references or
   * `Link` values.
   */
  readonly objectReferences: readonly string[];
  /**
   * Whether an embedded document or extension node object, at any depth, is
   * addressed to recipients but not to the public, so that serving the root
   * publicly would expose it to others.
   */
  readonly restricted: boolean;
  /**
   * Whether an extension node object has a `@context` of its own, which the
   * validator does not read, so that its blind recipients cannot be found.
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
  const documents = nodes.map(
    (node): Embedded => ({
      path: node.path,
      property: node.property,
      iri: ownIdentifier(node, node.kind === "link" ? "href" : "id"),
    }),
  );
  const extensions = nodes.flatMap((node) => node.extensions);
  const extensionValues = extensions.map(
    (node): Embedded => ({
      path: node.path,
      property: node.property,
      iri: ownId(node) ?? ownIdentifier(node, "href"),
    }),
  );
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
    objectReferences: nodes
      .filter(({ kind, type }) => kind === "activity" && type !== deleteType)
      .flatMap((node) => referredObjects(node, nodes)),
    restricted:
      embedded.some((node) => isRestricted(node, documents)) ||
      extensions.some((node) => isRestricted(node, extensionValues)),
    uninterpreted: extensions.some(({ uninterpreted }) => uninterpreted),
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
