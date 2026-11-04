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

import { type Database, type Transaction, schema } from "@drfed/models";
import {
  type Diagnostic,
  type JsonValue,
  type NormalizationChange,
  type ServerOwnedField,
  addressingProperties,
  describeDocument,
  diagnosticReasons,
  prepareDocument,
  validateDocument,
} from "@drfed/models/document";
import {
  type StoredResourceRevision,
  loadCurrentResourceRevision,
} from "@drfed/models/resource-revision";
import type {
  ActivityPubObject,
  AddressingProperty,
} from "@drfed/models/schema";
import { type Uuid, areUuidsEqual, validateUuid } from "@drfed/models/uuid";
import type { Federation } from "@fedify/fedify";
import { Activity } from "@fedify/vocab";
import { asc, eq } from "drizzle-orm";

import type { WritingActor } from "./actor.ts";
import {
  type IdentityLookups,
  checkIndexable,
  deniedClaims,
  indexDocument,
  pathKey,
} from "./prepare.ts";
import type { Allocation } from "./token.ts";
import {
  type TypedProjection,
  agreesWithRow,
  isTypedContext,
  projectTypedObject,
  typedContext,
} from "./typed.ts";
import {
  type DeleteRequest,
  type EditRequest,
  type JsonObject,
  type LocalWriteError,
  type PreparedResource,
  writeError,
} from "./types.ts";

const activityStreams = "https://www.w3.org/ns/activitystreams";
/** The allocation key of the activity an edit or deletion generates. */
export const generatedKey = pathKey(["#generated"]);

/** The current local object an edit or deletion acts on. */
export interface WriteTarget {
  readonly id: Uuid;
  readonly iri: string;
  readonly head: StoredResourceRevision & { readonly document: JsonObject };
  /** The legacy typed row, if the object has one. */
  readonly typed: ActivityPubObject | null;
  /** The type IRI of its current version. */
  readonly type: string;
}

/**
 * Checks an edit or deletion request's shape.
 * @returns Why it is malformed, or null.
 */
export function checkExistingRequest(
  request: EditRequest | DeleteRequest,
): LocalWriteError | null {
  const invalid = (message: string) => writeError("invalid_request", message);
  if (!validateUuid(request.actorId)) return invalid("Invalid actor ID.");
  if (!validateUuid(request.objectId)) return invalid("Invalid object ID.");
  if (!validateUuid(request.expectedRevisionId)) {
    return invalid("Invalid expected revision ID.");
  }
  if (
    request.operation === "edit" &&
    (request.document === null ||
      typeof request.document !== "object" ||
      Array.isArray(request.document))
  ) {
    return invalid("The document must be a JSON object.");
  }
  return null;
}

/**
 * The request as a preview token binds it.
 * @returns A JSON value to digest.
 */
export function bindableExisting(
  request: EditRequest | DeleteRequest,
): unknown {
  return {
    operation: request.operation,
    actorId: request.actorId,
    objectId: request.objectId,
    expectedRevisionId: request.expectedRevisionId,
    ...(request.operation === "edit" ? { document: request.document } : {}),
  };
}

function typeIri(document: JsonObject): string | null {
  const described = describeDocument(document)?.[0]?.type;
  if (described != null) return described;
  return typeof document.type === "string"
    ? `${activityStreams}#${document.type}`
    : null;
}

/**
 * Loads the object an edit or deletion acts on and checks that it is the
 * actor's current, live local object at the expected revision, and that a
 * typed row still agrees with its history.
 * @returns The target, or why the operation cannot act on it.
 */
export async function loadTarget(
  db: Database | Transaction,
  actor: WritingActor,
  objectId: Uuid,
  expectedRevisionId: Uuid,
): Promise<WriteTarget | LocalWriteError> {
  const unsupported = (message: string) =>
    writeError("unsupported_edit", message);
  const resource = await db.query.resources.findFirst({
    where: { id: objectId },
  });
  if (resource?.kind !== "object") {
    return unsupported("The resource is not an object.");
  }
  const head = await loadCurrentResourceRevision(db, objectId);
  if (head == null) return unsupported("The object has no saved version.");
  if (!areUuidsEqual(head.id, expectedRevisionId)) {
    return writeError(
      "revision_conflict",
      "The object changed after it was loaded; load it again.",
    );
  }
  if (head.kind === "whiteout") {
    return unsupported("The object is already deleted.");
  }
  const { document } = head;
  if (
    head.kind !== "snapshot" ||
    head.capture !== "local" ||
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document)
  ) {
    return unsupported("The object has no local document to change.");
  }
  const typed =
    (await db.query.objects.findFirst({ where: { id: objectId } })) ?? null;
  const current = document as JsonObject;
  const ownership = checkOwnership(current, typed, actor);
  if (ownership != null) return ownership;
  const type = typeIri(current);
  if (type == null) return unsupported("The object's type is unknown.");
  return {
    id: objectId,
    iri: resource.iri,
    head: { ...head, document: current },
    typed,
    type,
  };
}

/**
 * Reads an object's current addressing.
 * @returns Target IRIs by property, in position order.
 */
export async function currentAddressing(
  db: Database | Transaction,
  id: Uuid,
): Promise<Partial<Record<AddressingProperty, string[]>>> {
  const rows = await db
    .select({
      property: schema.addressing.property,
      iri: schema.resources.iri,
    })
    .from(schema.addressing)
    .innerJoin(
      schema.resources,
      eq(schema.resources.id, schema.addressing.targetId),
    )
    .where(eq(schema.addressing.sourceId, id))
    .orderBy(asc(schema.addressing.property), asc(schema.addressing.position));
  const result: Partial<Record<AddressingProperty, string[]>> = {};
  for (const { property, iri } of rows) (result[property] ??= []).push(iri);
  return result;
}

/**
 * Copies a document's addressing as written, under its own spellings.
 * @returns The addressing properties and their values.
 */
function copyAddressing(document: JsonObject): Record<string, JsonValue> {
  const root = describeDocument(document)?.[0];
  const copy: Record<string, JsonValue> = {};
  for (const property of addressingProperties) {
    for (const source of root?.properties.get(property) ?? []) {
      copy[source] = structuredClone(document[source]!);
    }
  }
  return copy;
}

function generatedIri(
  federation: Federation<unknown>,
  actor: WritingActor,
  id: Uuid,
): string {
  return federation
    .createContext(actor.origin, undefined)
    .getObjectUri(Activity, { id }).href;
}

/**
 * Checks that the current version belongs to the actor: a typed row must be
 * the actor's and agree with the history; a revision-only object must be
 * attributed to the actor alone.
 * @returns Why it may not be changed, or null.
 */
function checkOwnership(
  current: JsonObject,
  typed: ActivityPubObject | null,
  actor: WritingActor,
): LocalWriteError | null {
  const unsupported = (message: string) =>
    writeError("unsupported_edit", message);
  if (typed == null) {
    const root = describeDocument(current)?.[0];
    const authors = root?.identifiers.filter(
      ({ property }) => property === "attributedTo",
    );
    return authors?.length === 1 && authors[0]!.iri === actor.iri
      ? null
      : unsupported("The object is not the actor's.");
  }
  if (typed.actorId !== actor.id) {
    return unsupported("The object is not the actor's.");
  }
  const projection = projectTypedObject(current, true);
  return projection != null && agreesWithRow(projection, typed, actor.iri)
    ? null
    : unsupported(
        "The object's served state differs from its history; it cannot be changed safely.",
      );
}

function checkGenerated(document: JsonObject): LocalWriteError | null {
  const checked = validateDocument(document);
  return checked.complete &&
    !checked.diagnostics.some(({ severity }) => severity === "error")
    ? null
    : writeError(
        "invalid_document",
        "The generated activity is not valid.",
        checked.diagnostics,
      );
}

/** An edit or deletion, prepared to persist. */
export interface PreparedChange {
  readonly diagnostics: readonly Diagnostic[];
  readonly changes: readonly NormalizationChange[];
  /** The object's new version, absent for a deletion. */
  readonly object?: PreparedResource & {
    readonly typed: TypedProjection | null;
  };
  readonly activity: PreparedResource;
}

function generatedId(allocation: Allocation): Uuid | null {
  if (allocation.ids.size !== 1) return null;
  return allocation.ids.get(generatedKey) ?? null;
}

/**
 * Lets an edit submit the loaded document with its changes: the head's own
 * `updated` time is dropped for the server to replace, and an unreadable
 * legacy context is replaced by {@link typedContext}.  Any other value the
 * server owns still conflicts.
 * @returns The replacement changes made to the submitted copy.
 */
function recognizeServerValues(
  submitted: Record<string, JsonValue>,
  target: WriteTarget,
): NormalizationChange[] {
  const current = target.head.document;
  const changes: NormalizationChange[] = [];
  // The loaded document's own server values are replaced, not conflicts.
  const loaded = rootText(current, "updated");
  const resubmitted = rootSource(submitted, "updated");
  if (
    loaded != null &&
    resubmitted != null &&
    singleText(resubmitted.value) === loaded
  ) {
    delete submitted[resubmitted.source];
  }
  if (
    target.typed != null &&
    JSON.stringify(submitted["@context"]) ===
      JSON.stringify(current["@context"]) &&
    !isTypedContext(submitted["@context"])
  ) {
    changes.push({
      operation: "replace",
      reason: "replace_legacy_context",
      path: ["@context"],
      before: submitted["@context"] ?? null,
      after: typedContext,
      message:
        "The legacy serializer's context is replaced by one the validator reads.",
    });
    submitted["@context"] = typedContext;
  }
  return changes;
}

/**
 * Reads the publication time an edit keeps: the head document's, or the
 * typed column's when a legacy document has none.
 * @returns The time as written, or null when the object has none.
 */
function effectivePublished(target: WriteTarget): string | null {
  const published = rootText(target.head.document, "published");
  if (published != null) return published;
  return target.typed?.published.toString() ?? null;
}

/**
 * Reads a root property by meaning, whatever its spelling; a legacy
 * document the validator cannot read uses standard spellings.
 * @returns The first spelling's key and value, if any.
 */
function rootSource(
  document: JsonObject,
  property: string,
): { readonly source: string; readonly value: JsonValue } | undefined {
  const nodes = describeDocument(document);
  const source =
    nodes == null ? property : nodes[0]!.properties.get(property)?.[0];
  if (source == null || !(source in document)) return undefined;
  return { source, value: document[source]! };
}

/**
 * Reads a single-valued root property by meaning, in either its scalar or
 * its singleton-list form.
 * @returns The one non-null string value, if there is exactly one.
 */
function rootText(document: JsonObject, property: string): string | undefined {
  return singleText(rootSource(document, property)?.value);
}

function singleText(value: JsonValue | undefined): string | undefined {
  const values = [value].flat().filter((entry) => entry != null);
  return values.length === 1 && typeof values[0] === "string"
    ? values[0]
    : undefined;
}

/**
 * Prepares an actual edit: the object's new version with the server's
 * values, and the `Update` that propagates it, embedding that version and
 * copying its addressing as written.
 * @returns The prepared edit, or why it cannot happen.
 */
export async function prepareEdit(
  federation: Federation<unknown>,
  rootOrigin: URL,
  actor: WritingActor,
  target: WriteTarget,
  request: EditRequest,
  allocation: Allocation,
  lookups: IdentityLookups,
): Promise<PreparedChange | LocalWriteError> {
  const updateId = generatedId(allocation);
  if (updateId == null) {
    return writeError("stale_preview", "The preview no longer matches.");
  }
  const submitted = structuredClone(request.document) as Record<
    string,
    JsonValue
  >;
  const changes = recognizeServerValues(submitted, target);
  const nodes = describeDocument(submitted);
  if (nodes == null) {
    return writeError(
      "invalid_document",
      "The document is not valid.",
      validateDocument(submitted).diagnostics,
    );
  }
  const root = nodes[0]!;
  if (root.type !== target.type) {
    return writeError(
      "unsupported_edit",
      "An edit cannot change the object's type.",
    );
  }
  const timestamp = allocation.timestamp.toString();
  const published = effectivePublished(target);
  const serverOwnedFields: ServerOwnedField[] = [
    { path: ["id"], value: target.iri },
    { path: ["attributedTo"], value: actor.iri },
    { path: ["updated"], value: timestamp },
    ...(published == null ? [] : [{ path: ["published"], value: published }]),
  ];
  // Null means absence, which keeps the publication time missing.
  const addedPublished = (root.properties.get("published") ?? []).filter(
    (source) => ![submitted[source]].flat().every((value) => value === null),
  );
  if (published == null && addedPublished.length > 0) {
    return writeError(
      "invalid_document",
      "The object had no publication time, so none can be added.",
      addedPublished.map((source) => ({
        reason: "server_owned_field_conflict",
        ...diagnosticReasons.server_owned_field_conflict,
        path: [source],
        message: "The publication time is owned by the server.",
      })),
    );
  }
  const updateIri = generatedIri(federation, actor, updateId);
  const denied = await deniedClaims(
    nodes,
    new Map([[pathKey([]), "object" as const]]),
    new Set([updateIri]),
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
  const version = structuredClone(
    result.normalizedDocument ?? submitted,
  ) as JsonObject;
  // The Update copies the version's addressing, so this covers both.
  const unindexable = checkIndexable(version);
  if (unindexable.length > 0) {
    return writeError(
      "invalid_document",
      "The document cannot be saved as submitted.",
      unindexable,
    );
  }
  let typed: TypedProjection | null = null;
  if (target.typed != null) {
    typed = projectTypedObject(version);
    if (typed == null) {
      return writeError(
        "unsupported_edit",
        "This object is also served from its legacy Note/Article columns, " +
          "which cannot represent the edited version yet.",
      );
    }
  }
  const { "@context": context, ...embedded } = version;
  const update: JsonObject = {
    ...(context === undefined ? {} : { "@context": context }),
    id: updateIri,
    type: "Update",
    actor: actor.iri,
    object: embedded,
    published: timestamp,
    ...copyAddressing(version),
  };
  const generatedError = checkGenerated(update);
  if (generatedError != null) return generatedError;
  return {
    diagnostics: result.diagnostics,
    changes: [...changes, ...result.changes],
    object: {
      path: [],
      kind: "object",
      id: target.id,
      iri: target.iri,
      generated: false,
      document: version,
      typed,
      ...indexDocument(version),
    },
    activity: {
      path: [],
      kind: "activity",
      id: updateId,
      iri: updateIri,
      generated: true,
      document: update,
      ...indexDocument(update),
    },
  };
}

/**
 * Prepares an actual deletion: the `Delete` that propagates it, referring to
 * the object and copying the addressing of its last version.
 * @returns The prepared deletion, or why it cannot happen.
 */
export async function prepareDelete(
  federation: Federation<unknown>,
  actor: WritingActor,
  target: WriteTarget,
  allocation: Allocation,
  addressing: () => Promise<Partial<Record<AddressingProperty, string[]>>>,
): Promise<PreparedChange | LocalWriteError> {
  const deleteId = generatedId(allocation);
  if (deleteId == null) {
    return writeError("stale_preview", "The preview no longer matches.");
  }
  const current = target.head.document;
  const iri = generatedIri(federation, actor, deleteId);
  // A document the validator reads keeps its context and spellings; a
  // legacy one is described by its complete standard addressing rows.
  const readable = describeDocument(current) != null;
  const context = current["@context"];
  const document: JsonObject = {
    ...(readable
      ? context === undefined
        ? {}
        : { "@context": context }
      : { "@context": activityStreams }),
    id: iri,
    type: "Delete",
    actor: actor.iri,
    object: target.iri,
    published: allocation.timestamp.toString(),
    ...(readable ? copyAddressing(current) : await addressing()),
  };
  const generatedError = checkGenerated(document);
  if (generatedError != null) return generatedError;
  return {
    diagnostics: [],
    changes: [],
    activity: {
      path: [],
      kind: "activity",
      id: deleteId,
      iri,
      generated: true,
      document,
      ...indexDocument(document),
    },
  };
}
