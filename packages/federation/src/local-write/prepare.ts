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
  type Diagnostic,
  type DocumentAuthority,
  type DocumentNode,
  type FieldPath,
  type JsonValue,
  type NormalizationChange,
  type ServerOwnedField,
  describeDocument,
  diagnosticReasons,
  prepareDocument,
  validateDocument,
} from "@drfed/models/document";
import type { AddressingOccurrence } from "@drfed/models/resource";
import type { RevisionRelationInput } from "@drfed/models/resource-revision";
import { type Uuid, uuidV7, validateUuid } from "@drfed/models/uuid";
import type { Federation } from "@fedify/fedify";
import { Object as APObject, Activity, Create } from "@fedify/vocab";

import { classifyHost } from "../origin.ts";
import type { WritingActor } from "./actor.ts";
import { type Allocation, toMicroseconds } from "./token.ts";
import {
  type CreateRequest,
  type JsonObject,
  type LocalWriteError,
  type NewResource,
  type PreparedResource,
  writeError,
} from "./types.ts";

const activityStreams = "https://www.w3.org/ns/activitystreams";
const questionType = `${activityStreams}#Question`;
const createType = `${activityStreams}#Create`;
/** Activity relations whose embedded documents may become new resources. */
const nestingProperties: ReadonlySet<string> = new Set([
  "object",
  "target",
  "origin",
  "result",
  "instrument",
]);
const addressingProperties = ["to", "cc", "bto", "bcc", "audience"] as const;
const relationProperties = [
  "actor",
  "object",
  "target",
  "origin",
  "result",
  "instrument",
  "attributedTo",
] as const;

/** Database answers the preparation needs about local identities. */
export interface IdentityLookups {
  /** The IRIs that name live local actors of the acting actor's instance. */
  localActors(iris: readonly string[]): Promise<ReadonlySet<string>>;
  /** The IRIs that are registered resources. */
  registered(iris: readonly string[]): Promise<ReadonlySet<string>>;
}

/** The submitted documents and their saved forms, ready to persist. */
export interface PreparedWrite {
  readonly diagnostics: readonly Diagnostic[];
  readonly changes: readonly NormalizationChange[];
  readonly resources: readonly PreparedResource[];
}

/**
 * Keys a path for maps and token allocations.
 * @returns The path's JSON.
 */
export function pathKey(path: FieldPath): string {
  return JSON.stringify(path);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPath(value: unknown): value is FieldPath {
  return (
    Array.isArray(value) &&
    value.every(
      (segment) =>
        typeof segment === "string" ||
        (Number.isSafeInteger(segment) && segment >= 0),
    )
  );
}

/**
 * Checks the request's shape before anything reads its document, since the
 * request may come straight from a client.
 * @returns Why the request is malformed, or null.
 */
export function checkCreateRequest(
  request: CreateRequest,
): LocalWriteError | null {
  const invalid = (message: string) => writeError("invalid_request", message);
  if (!isPlainObject(request) || request.operation !== "create") {
    return invalid("Expected a create request.");
  }
  if (!validateUuid(request.actorId)) return invalid("Invalid actor ID.");
  if (!isPlainObject(request.document)) {
    return invalid("The document must be a JSON object.");
  }
  if (request.publish !== undefined && typeof request.publish !== "boolean") {
    return invalid("publish must be a boolean.");
  }
  if (!Array.isArray(request.resources)) {
    return invalid("resources must be an array.");
  }
  for (const resource of request.resources as unknown[]) {
    if (
      !isPlainObject(resource) ||
      !isPath(resource.path) ||
      (resource.kind !== "object" && resource.kind !== "activity") ||
      (resource.representation !== undefined &&
        resource.representation !== "embedded" &&
        resource.representation !== "reference")
    ) {
      return invalid(
        "Each resource needs a path, a kind of object or activity, and an " +
          "optional representation of embedded or reference.",
      );
    }
  }
  return null;
}

/**
 * The request as a preview token binds it, with defaults spelled out.
 * @returns A JSON value to digest.
 */
export function bindableRequest(request: CreateRequest): unknown {
  return {
    operation: request.operation,
    actorId: request.actorId,
    document: request.document,
    resources: request.resources.map(({ path, kind, representation }) => ({
      path,
      kind,
      representation: representation ?? "embedded",
    })),
    publish: request.publish === true,
  };
}

function parentPath(path: FieldPath): FieldPath {
  return typeof path.at(-1) === "number"
    ? path.slice(0, -2)
    : path.slice(0, -1);
}

function savableAs(kind: NewResource["kind"], node: DocumentNode): boolean {
  return kind === "activity"
    ? node.kind === "activity"
    : node.kind === "object" || node.type === questionType;
}

function checkPublication(
  request: CreateRequest,
  nodes: ReadonlyMap<string, DocumentNode>,
): LocalWriteError | null {
  if (request.publish !== true) return null;
  const root = nodes.get(pathKey([]));
  const rootKind = request.resources.find(
    ({ path }) => path.length === 0,
  )?.kind;
  return root?.kind === "activity" && rootKind === "activity"
    ? null
    : writeError("invalid_request", "Only an activity can be published.");
}

function checkDescriptors(
  request: CreateRequest,
  nodes: ReadonlyMap<string, DocumentNode>,
): LocalWriteError | null {
  const invalid = (message: string) => writeError("invalid_request", message);
  const paths = new Set<string>();
  for (const { path } of request.resources) {
    if (paths.has(pathKey(path))) {
      return invalid(`The resource ${pathKey(path)} is listed twice.`);
    }
    paths.add(pathKey(path));
  }
  if (!paths.has(pathKey([]))) {
    return invalid("The root document must be one of the new resources.");
  }
  for (const { path, kind, representation } of request.resources) {
    const node = nodes.get(pathKey(path));
    if (node == null) {
      return invalid(`${pathKey(path)} is not an embedded document.`);
    }
    if (!savableAs(kind, node)) {
      return invalid(
        `${pathKey(path)} is not ${kind === "activity" ? "an activity" : "an object"} ` +
          "that can be saved as a local resource.",
      );
    }
    if (path.length === 0) {
      if (representation !== undefined) {
        return invalid("The root document has no representation.");
      }
      continue;
    }
    if (
      node.property == null ||
      !nestingProperties.has(node.property) ||
      !paths.has(pathKey(parentPath(path)))
    ) {
      return invalid(
        `${pathKey(path)} must be embedded in a new resource's object, ` +
          "target, origin, result, or instrument.",
      );
    }
  }
  return checkPublication(request, nodes);
}

/**
 * Allocates fresh server values for a request's new resources.
 * @returns The allocation a preview token will carry.
 */
export function allocate(resources: readonly NewResource[]): Allocation {
  return {
    ids: new Map(resources.map(({ path }) => [pathKey(path), uuidV7()])),
    timestamp: toMicroseconds(Temporal.Now.instant()),
  };
}

function valueAt(document: JsonValue, path: FieldPath): JsonValue | undefined {
  let value: JsonValue | undefined = document;
  for (const segment of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, JsonValue>)[segment];
  }
  return value;
}

function setAt(document: JsonObject, path: FieldPath, value: JsonValue): void {
  const parent = valueAt(document, path.slice(0, -1)) as Record<
    string | number,
    JsonValue
  >;
  parent[path.at(-1)!] = value;
}

function resourceIri(
  federation: Federation<unknown>,
  actor: WritingActor,
  kind: NewResource["kind"],
  type: string,
  id: Uuid,
): string {
  const ctx = federation.createContext(actor.origin, undefined);
  if (kind === "object") {
    return ctx.getObjectUri(APObject, { identifier: actor.id, id }).href;
  }
  return (
    type === createType
      ? ctx.getObjectUri(Create, { id })
      : ctx.getObjectUri(Activity, { id })
  ).href;
}

/**
 * Finds identity claims on DrFed instance hosts in documents that are not
 * new resources: `actor` and `attributedTo` values, which must be actors of
 * the acting actor's instance, and `id` values, which must be registered or
 * allocated in this write.  Values are compared as the context resolves
 * them, so aliases and compact IRIs cannot hide a claim.
 * @returns The denied claims' paths.
 */
export async function deniedClaims(
  nodes: readonly DocumentNode[],
  created: ReadonlyMap<string, NewResource["kind"]>,
  allocated: ReadonlySet<string>,
  rootOrigin: URL,
  lookups: IdentityLookups,
): Promise<DocumentAuthority[]> {
  const actors: { iri: string; path: FieldPath }[] = [];
  const ids: { iri: string; path: FieldPath }[] = [];
  for (const node of nodes) {
    // A new resource's id and author are server-owned; checking them here
    // would only repeat the conflict preparation reports.  Its other
    // attribution property, such as attributedTo on an activity, is a claim.
    const createdKind = created.get(pathKey(node.path));
    const owned = createdKind === "activity" ? "actor" : "attributedTo";
    const embedsActor =
      node.property === "actor" || node.property === "attributedTo";
    for (const { property, iri, path } of node.identifiers) {
      if (createdKind != null && (property === "id" || property === owned)) {
        continue;
      }
      const isActor =
        property === "actor" ||
        property === "attributedTo" ||
        (property === "id" && embedsActor);
      if (!isActor && property !== "id") continue;
      if (
        !URL.canParse(iri) ||
        classifyHost(new URL(iri), rootOrigin) !== "instance"
      ) {
        continue;
      }
      (isActor ? actors : ids).push({ iri, path });
    }
  }
  const [localActors, registered] = await Promise.all([
    lookups.localActors([...new Set(actors.map(({ iri }) => iri))]),
    lookups.registered([...new Set(ids.map(({ iri }) => iri))]),
  ]);
  return [
    ...actors.filter(({ iri }) => !localActors.has(iri)),
    ...ids.filter(({ iri }) => !registered.has(iri) && !allocated.has(iri)),
  ].map(({ path }) => ({ allowed: false, path }));
}

function contextEntries(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

/**
 * Refuses a document that spells one indexed property in several ways, as
 * in `to` beside an alias of it: their occurrences would share positions,
 * and an index that silently left some out could hide a recipient.
 * @returns The findings at every spelling after the first.
 */
export function checkIndexable(document: JsonObject): Diagnostic[] {
  const root = describeDocument(document)?.find(
    ({ path }) => path.length === 0,
  );
  const diagnostics: Diagnostic[] = [];
  for (const property of [...addressingProperties, ...relationProperties]) {
    for (const source of root?.properties.get(property)?.slice(1) ?? []) {
      diagnostics.push({
        reason: "unsupported_value_form",
        ...diagnosticReasons.unsupported_value_form,
        path: [source],
        message: `Several spellings of ${property} cannot be saved yet; use one.`,
      });
    }
  }
  return diagnostics;
}

/**
 * Indexes a saved document's root addressing and relations by meaning.
 * @returns Addressing occurrences at their source positions, and relations.
 */
export function indexDocument(document: JsonObject): {
  addressing: AddressingOccurrence[];
  relations: RevisionRelationInput[];
} {
  const nodes = describeDocument(document) ?? [];
  const root = nodes.find(({ path }) => path.length === 0);
  if (root == null) return { addressing: [], relations: [] };
  const children = new Map(nodes.map((node) => [pathKey(node.path), node]));
  const identifiers = new Map(
    root.identifiers.map((entry) => [pathKey(entry.path), entry.iri]),
  );
  // An embedded document names a target by its id; a Link by its href.
  const target = (path: FieldPath): string | undefined => {
    const fromRoot = identifiers.get(pathKey(path));
    if (fromRoot != null) return fromRoot;
    const node = children.get(pathKey(path));
    if (node == null) return undefined;
    const property = node.kind === "link" ? "href" : "id";
    return node.identifiers.find(
      (entry) =>
        entry.property === property && entry.path.length === path.length + 1,
    )?.iri;
  };
  const occurrences = (
    property: string,
  ): { path: FieldPath; position: number }[] => {
    // Several spellings of one property were refused by checkIndexable().
    const source = root.properties.get(property)?.[0];
    if (source == null) return [];
    const value = document[source];
    if (Array.isArray(value)) {
      return value.map((_, position) => ({
        path: [source, position],
        position,
      }));
    }
    return value == null ? [] : [{ path: [source], position: 0 }];
  };
  const addressing: AddressingOccurrence[] = [];
  for (const property of addressingProperties) {
    for (const { path, position } of occurrences(property)) {
      const iri = target(path);
      if (iri != null) addressing.push({ property, position, iri });
    }
  }
  const relations: RevisionRelationInput[] = [];
  for (const property of relationProperties) {
    for (const { path } of occurrences(property)) {
      const node = children.get(pathKey(path));
      if (node == null) {
        const iri = identifiers.get(pathKey(path));
        if (iri != null) {
          relations.push({
            property,
            path,
            representation: "reference",
            targetIri: iri,
          });
        }
      } else {
        relations.push({
          property,
          path,
          representation: node.kind === "link" ? "link" : "embedded",
          targetIri: target(path) ?? null,
        });
      }
    }
  }
  return { addressing, relations };
}

/**
 * Splits a nested new resource out of the prepared document: its own saved
 * document states the context it inherited, and is checked on its own.
 * @returns The embedded value, its standalone document, and the context
 *          change, or why it is not valid on its own.
 */
function extractNested(
  prepared: JsonObject,
  preparedNodes: ReadonlySet<string>,
  working: JsonObject,
  path: FieldPath,
):
  | {
      value: JsonObject;
      standalone: Record<string, JsonValue>;
      changes: NormalizationChange[];
    }
  | LocalWriteError {
  const changes: NormalizationChange[] = [];
  const value = valueAt(working, path) as JsonObject;
  const standalone = structuredClone(value) as Record<string, JsonValue>;
  const chain: JsonValue[] = [];
  for (let length = 0; length <= path.length; length += 1) {
    const prefix = path.slice(0, length);
    if (!preparedNodes.has(pathKey(prefix))) continue;
    const own = valueAt(prepared, [...prefix, "@context"]);
    chain.push(...contextEntries(own));
  }
  const own = value["@context"];
  // The validator reads a document without a context as ActivityStreams.
  if (prepared["@context"] === undefined) chain.unshift(activityStreams);
  if (chain.length > 0) {
    const context = chain.length === 1 ? chain[0]! : chain;
    if (JSON.stringify(context) !== JSON.stringify(own ?? null)) {
      standalone["@context"] = context;
      changes.push(
        own === undefined
          ? {
              operation: "add",
              reason: "materialize_effective_context",
              path: [...path, "@context"],
              after: context,
              message: "The saved resource states the context it inherited.",
            }
          : {
              operation: "replace",
              reason: "materialize_effective_context",
              path: [...path, "@context"],
              before: own,
              after: context,
              message: "The saved resource states the context it inherited.",
            },
      );
    }
  }
  const checked = validateDocument(standalone);
  if (
    !checked.complete ||
    checked.diagnostics.some(({ severity }) => severity === "error")
  ) {
    return writeError(
      "invalid_document",
      "A nested resource is not valid on its own.",
      checked.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: [...path, ...diagnostic.path],
      })),
    );
  }
  return { value, standalone, changes };
}

/**
 * Prepares a create request: checks its descriptors, applies the server's
 * values, checks identity claims, and splits out each new resource's saved
 * document.  It writes nothing; a commit runs it again under its locks.
 * @returns The prepared write, or why it cannot be written.
 */
export async function prepareCreate(
  federation: Federation<unknown>,
  rootOrigin: URL,
  actor: WritingActor,
  request: CreateRequest,
  allocation: Allocation,
  lookups: IdentityLookups,
): Promise<PreparedWrite | LocalWriteError> {
  const submitted = request.document;
  const nodes = describeDocument(submitted);
  if (nodes == null) {
    return writeError(
      "invalid_document",
      "The document is not valid.",
      validateDocument(submitted).diagnostics,
    );
  }
  const byPath = new Map(nodes.map((node) => [pathKey(node.path), node]));
  const descriptorError = checkDescriptors(request, byPath);
  if (descriptorError != null) return descriptorError;
  const keys = request.resources.map(({ path }) => pathKey(path));
  if (
    allocation.ids.size !== keys.length ||
    keys.some((key) => !allocation.ids.has(key))
  ) {
    return writeError("stale_preview", "The preview no longer matches.");
  }
  const published = allocation.timestamp.toString();
  const planned = request.resources.map((resource) => {
    const id = allocation.ids.get(pathKey(resource.path))!;
    const node = byPath.get(pathKey(resource.path))!;
    return {
      ...resource,
      id,
      iri: resourceIri(federation, actor, resource.kind, node.type, id),
    };
  });
  const serverOwnedFields: ServerOwnedField[] = planned.flatMap(
    ({ path, kind, iri }) => [
      { path: [...path, "id"], value: iri },
      {
        path: [...path, kind === "activity" ? "actor" : "attributedTo"],
        value: actor.iri,
      },
      { path: [...path, "published"], value: published },
    ],
  );
  const denied = await deniedClaims(
    nodes,
    new Map(planned.map(({ path, kind }) => [pathKey(path), kind])),
    new Set(planned.map(({ iri }) => iri)),
    rootOrigin,
    lookups,
  );
  const result = prepareDocument(submitted, {
    authority: [{ allowed: true, path: [] }, ...denied],
    serverOwnedFields,
  });
  if (
    !result.complete ||
    result.diagnostics.some(({ severity }) => severity === "error")
  ) {
    return writeError(
      "invalid_document",
      "The document cannot be saved as submitted.",
      result.diagnostics,
    );
  }
  const prepared = structuredClone(
    result.normalizedDocument ?? submitted,
  ) as JsonObject;
  const unindexable = checkIndexable(prepared);
  if (unindexable.length > 0) {
    return writeError(
      "invalid_document",
      "The document cannot be saved as submitted.",
      unindexable,
    );
  }
  const preparedNodes = new Set(
    (describeDocument(prepared) ?? []).map(({ path }) => pathKey(path)),
  );
  const working = structuredClone(prepared) as Record<string, JsonValue>;
  const changes: NormalizationChange[] = [...result.changes];
  const diagnostics: Diagnostic[] = [...result.diagnostics];
  const resources: PreparedResource[] = [];
  // Deepest first, so that a parent embeds or refers to its saved children.
  for (const resource of planned.toSorted(
    (left, right) => right.path.length - left.path.length,
  )) {
    const { path, kind, id, iri, representation } = resource;
    let document: JsonObject;
    if (path.length === 0) {
      document = working;
    } else {
      const extracted = extractNested(prepared, preparedNodes, working, path);
      if ("type" in extracted) return extracted;
      changes.push(...extracted.changes);
      const { value, standalone } = extracted;
      const nestedUnindexable = checkIndexable(standalone);
      if (nestedUnindexable.length > 0) {
        return writeError(
          "invalid_document",
          "A nested resource cannot be saved as submitted.",
          nestedUnindexable.map((diagnostic) => ({
            ...diagnostic,
            path: [...path, ...diagnostic.path],
          })),
        );
      }
      document = standalone;
      if (representation === "reference") {
        setAt(working, path, iri);
        changes.push({
          operation: "replace",
          reason: "reference_created_resource",
          path,
          before: value,
          after: iri,
          message: "The parent refers to the new resource by its IRI.",
        });
      }
    }
    resources.push({
      path,
      kind,
      id,
      iri,
      document,
      ...indexDocument(document),
    });
  }
  return { diagnostics, changes, resources };
}
