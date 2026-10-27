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

import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import type { Database, Transaction } from "./db.ts";
import { LegacyResourceRevisionError } from "./legacy-resource-revision-error.ts";
import { ResourceRevisionStateError } from "./resource-revision-state-error.ts";
import { type AddressingInput, ResourceKindConflictError } from "./resource.ts";
import { RevisionConflictError } from "./revision-conflict-error.ts";
import {
  type ResourceRevision,
  type RevisionAddressing,
  type RevisionRelation,
  activities,
  addressingPropertyEnum,
  objects,
  resourceHeads,
  resourceRevisionCaptureEnum,
  resourceRevisionProjectionEnum,
  resourceRevisions,
  resources,
  revisionAddressing,
  revisionRelations,
} from "./schema.ts";
import { storableText } from "./text.ts";
import { type Uuid, areUuidsEqual, uuidV7, validateUuid } from "./uuid.ts";

/** A value representable by JSON, without implicit coercion. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | {
      readonly [property: string]: JsonValue;
    };
export type JsonObject = { readonly [property: string]: JsonValue };

/** A semantic adapter's relation projection; no JSON-LD interpretation occurs here. */
export interface RevisionRelationInput {
  readonly property: string;
  readonly path?: readonly (string | number)[] | null;
  readonly representation: RevisionRelation["representation"];
  readonly targetIri?: string | null;
}

interface AppendBase {
  readonly resourceId: Uuid;
  readonly resourceKind: "object" | "activity";
  /** Null requires that the resource has no current revision. */
  readonly expectedRevisionId: Uuid | null;
}
export type AppendResourceRevisionInput = AppendBase &
  (
    | {
        readonly kind: "snapshot";
        readonly document: JsonObject;
        readonly capture: ResourceRevision["capture"];
        readonly addressing?: AddressingInput;
        readonly relations?: readonly RevisionRelationInput[];
        readonly projection?: ResourceRevision["projection"];
      }
    | {
        readonly kind: "whiteout";
        readonly deleted: Temporal.Instant;
        readonly formerTypes: readonly string[];
      }
  );

/** Protected local JSON and projections, not an authorized or wire representation. */
export interface StoredResourceRevision extends ResourceRevision {
  readonly addressing: readonly RevisionAddressing[];
  readonly relations: readonly RevisionRelation[];
}

export { RevisionConflictError } from "./revision-conflict-error.ts";
export { LegacyResourceRevisionError } from "./legacy-resource-revision-error.ts";
export { ResourceRevisionStateError } from "./resource-revision-state-error.ts";

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !storableText(value)) {
    throw new TypeError("A projection must contain losslessly storable text.");
  }
}

function jsonKeys(value: object): string[] {
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype
      : prototype !== Object.prototype && prototype !== null
  ) {
    throw new TypeError("JSON objects must be plain records.");
  }
  const result: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !("value" in descriptor)
    ) {
      throw new TypeError(
        "JSON values cannot contain symbol keys or accessors.",
      );
    }
    if (Array.isArray(value) && key === "length") continue;
    if (!descriptor.enumerable) {
      throw new TypeError("JSON members must be enumerable.");
    }
    if (
      Array.isArray(value) &&
      (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)
    ) {
      throw new TypeError("JSON arrays cannot contain named properties.");
    }
    result.push(key);
  }
  return result;
}

// Produce JSON directly so negative zero and escaped Unicode are retained.
function json(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JSON numbers must be finite.");
    }
    return Object.is(value, -0) ? "-0" : JSON.stringify(value);
  }
  if (typeof value !== "object" || ancestors.has(value)) {
    throw new TypeError("Expected an acyclic JSON value without coercion.");
  }
  const keys = jsonKeys(value);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (entry: unknown) => json(entry, ancestors)).join(",")}]`;
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${json(Object.getOwnPropertyDescriptor(value, key)!.value, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function projectionRows(
  input: AddressingInput = {},
): Omit<RevisionAddressing, "revisionId">[] {
  const rows: Omit<RevisionAddressing, "revisionId">[] = [];
  for (const property of Object.keys(input)) {
    if (
      !addressingPropertyEnum.enumValues.includes(
        property as RevisionAddressing["property"],
      )
    ) {
      throw new TypeError("Unknown addressing projection property.");
    }
  }
  for (const property of addressingPropertyEnum.enumValues) {
    const values = input[property];
    if (values === undefined) continue;
    if (!Array.isArray(values)) {
      throw new TypeError("Addressing projections must be arrays.");
    }
    for (const [position, iri] of values.entries()) {
      text(iri);
      rows.push({ property, position, iri });
    }
  }
  return rows;
}

function relationRows(
  input: readonly RevisionRelationInput[] = [],
): Omit<RevisionRelation, "revisionId">[] {
  if (!Array.isArray(input)) {
    throw new TypeError("Relation projections must be arrays.");
  }
  return input.map((relation, occurrence) => {
    text(relation.property);
    const targetIri = relation.targetIri ?? null;
    if (targetIri !== null) text(targetIri);
    if (
      !["reference", "embedded", "link"].includes(relation.representation) ||
      (relation.representation === "reference" && targetIri === null)
    ) {
      throw new TypeError("Invalid relation representation.");
    }
    const path = relation.path ?? null;
    if (
      path !== null &&
      (!Array.isArray(path) ||
        Array.from(path).some(
          (part) =>
            typeof part !== "string" &&
            !(Number.isSafeInteger(part) && part >= 0),
        ))
    ) {
      throw new TypeError(
        "A relation path must contain field names and nonnegative indexes.",
      );
    }
    return {
      occurrence,
      property: relation.property,
      representation: relation.representation,
      targetIri,
      path: path === null ? null : [...path],
    };
  });
}

async function current(
  db: Database | Transaction,
  resourceId: Uuid,
): Promise<ResourceRevision | null> {
  const [row] = await db
    .select({ revision: resourceRevisions })
    .from(resourceHeads)
    .innerJoin(
      resourceRevisions,
      and(
        eq(resourceHeads.resourceId, resourceRevisions.resourceId),
        eq(resourceHeads.revisionId, resourceRevisions.id),
      ),
    )
    .where(eq(resourceHeads.resourceId, resourceId))
    .limit(1);
  return row?.revision ?? null;
}

async function hydrate(
  db: Database | Transaction,
  revision: ResourceRevision,
): Promise<StoredResourceRevision> {
  const [addressing, relations] = await Promise.all([
    db
      .select()
      .from(revisionAddressing)
      .where(eq(revisionAddressing.revisionId, revision.id))
      .orderBy(revisionAddressing.property, revisionAddressing.position),
    db
      .select()
      .from(revisionRelations)
      .where(eq(revisionRelations.revisionId, revision.id))
      .orderBy(revisionRelations.occurrence),
  ]);
  return { ...revision, addressing, relations };
}

interface PreparedRevision extends AppendBase {
  readonly kind: "snapshot" | "whiteout";
  readonly serialized: string | null;
  readonly capture: ResourceRevision["capture"] | undefined;
  readonly projection: ResourceRevision["projection"] | undefined;
  readonly addressing: Omit<RevisionAddressing, "revisionId">[];
  readonly relations: Omit<RevisionRelation, "revisionId">[];
  readonly deleted: Temporal.Instant | null;
  readonly formerTypes: string[] | null;
}

type PreparedValue = Omit<PreparedRevision, keyof AppendBase>;
function prepareSnapshot(
  input: Extract<AppendResourceRevisionInput, { kind: "snapshot" }>,
): PreparedValue {
  if (
    input.document === null ||
    typeof input.document !== "object" ||
    Array.isArray(input.document)
  ) {
    throw new TypeError("A new resource document must be a JSON object.");
  }
  const projection = input.projection ?? "partial";
  if (
    !resourceRevisionCaptureEnum.enumValues.includes(input.capture) ||
    !resourceRevisionProjectionEnum.enumValues.includes(projection)
  ) {
    throw new TypeError("Invalid capture or projection category.");
  }
  return {
    kind: "snapshot",
    serialized: json(input.document),
    capture: input.capture,
    projection,
    addressing: projectionRows(input.addressing),
    relations: relationRows(input.relations),
    deleted: null,
    formerTypes: null,
  };
}

function prepareWhiteout(
  input: Extract<AppendResourceRevisionInput, { kind: "whiteout" }>,
): PreparedValue {
  if (
    !(input.deleted instanceof Temporal.Instant) ||
    !Array.isArray(input.formerTypes)
  ) {
    throw new TypeError("Expected a deletion instant and former type array.");
  }
  const formerTypes = [...input.formerTypes];
  for (const type of formerTypes) text(type);
  return {
    kind: "whiteout",
    serialized: null,
    capture: undefined,
    projection: undefined,
    addressing: [],
    relations: [],
    deleted: input.deleted,
    formerTypes,
  };
}

function prepareRevision(input: AppendResourceRevisionInput): PreparedRevision {
  const { resourceId, resourceKind, expectedRevisionId } = input;
  if (
    !validateUuid(resourceId) ||
    (expectedRevisionId !== null && !validateUuid(expectedRevisionId))
  ) {
    throw new TypeError("Expected canonical resource and revision UUIDs.");
  }
  if (resourceKind !== "object" && resourceKind !== "activity") {
    throw new TypeError("Unsupported resource kind.");
  }
  if (input.kind === "snapshot") {
    return {
      resourceId,
      resourceKind,
      expectedRevisionId,
      ...prepareSnapshot(input),
    };
  }
  if (input.kind === "whiteout") {
    return {
      resourceId,
      resourceKind,
      expectedRevisionId,
      ...prepareWhiteout(input),
    };
  }
  throw new TypeError("Unsupported revision kind.");
}

async function lockRevisionTarget(
  tx: Transaction,
  input: PreparedRevision,
): Promise<ResourceRevision | null> {
  const { resourceId, resourceKind, expectedRevisionId, kind } = input;
  const [resource] = await tx
    .select()
    .from(resources)
    .where(eq(resources.id, resourceId))
    .for("no key update");
  if (resource === undefined) {
    throw new Error("The canonical resource is not registered.");
  }
  // Read the head separately after the resource lock, including after a wait.
  const previous = await current(tx, resourceId);
  const matches =
    previous === null
      ? expectedRevisionId === null
      : expectedRevisionId !== null &&
        areUuidsEqual(previous.id, expectedRevisionId);
  if (!matches) {
    throw new RevisionConflictError(
      resourceId,
      expectedRevisionId,
      previous?.id ?? null,
    );
  }
  const [legacyObject, legacyActivity] = await Promise.all([
    tx
      .select({ id: objects.id })
      .from(objects)
      .where(eq(objects.id, resourceId))
      .limit(1),
    tx
      .select({ id: activities.id })
      .from(activities)
      .where(eq(activities.id, resourceId))
      .limit(1),
  ]);
  if (legacyObject.length > 0 || legacyActivity.length > 0) {
    throw new LegacyResourceRevisionError(resourceId);
  }
  if (resource.kind !== "unknown" && resource.kind !== resourceKind) {
    throw new ResourceKindConflictError(
      resource.iri,
      resource.kind,
      resourceKind,
    );
  }
  if (previous !== null && resourceKind === "activity") {
    throw new ResourceRevisionStateError("activity-immutable");
  }
  if (previous?.kind === "whiteout") {
    throw new ResourceRevisionStateError("deleted");
  }
  if (kind === "whiteout" && previous === null) {
    throw new ResourceRevisionStateError("initial-whiteout");
  }
  if (resource.kind === "unknown") {
    await tx
      .update(resources)
      .set({ kind: resourceKind })
      .where(eq(resources.id, resourceId));
  }
  return previous;
}

async function appendPrepared(
  tx: Transaction,
  input: PreparedRevision,
): Promise<StoredResourceRevision> {
  const previous = await lockRevisionTarget(tx, input);
  const {
    resourceId,
    kind,
    serialized,
    capture,
    projection,
    deleted,
    formerTypes,
    addressing,
    relations,
  } = input;
  const id = uuidV7();
  const [revision] = await tx
    .insert(resourceRevisions)
    .values({
      id,
      resourceId,
      sequence: (previous?.sequence ?? 0) + 1,
      kind,
      capture: capture ?? previous!.capture,
      projection: projection ?? previous!.projection,
      document: serialized === null ? null : sql`${serialized}::json`,
      deleted,
      formerTypes,
    })
    .returning();
  if (revision === undefined) {
    throw new Error("Revision insertion returned no row.");
  }
  if (kind === "whiteout") {
    const inherited = await hydrate(tx, previous!);
    addressing.push(
      ...inherited.addressing.map(({ revisionId: _revisionId, ...row }) => row),
    );
    relations.push(
      ...inherited.relations.map(({ revisionId: _revisionId, ...row }) => row),
    );
  }
  if (addressing.length > 0) {
    await tx
      .insert(revisionAddressing)
      .values(addressing.map((row) => ({ ...row, revisionId: id })));
  }
  if (relations.length > 0) {
    await tx
      .insert(revisionRelations)
      .values(relations.map((row) => ({ ...row, revisionId: id })));
  }
  if (previous === null) {
    await tx.insert(resourceHeads).values({ resourceId, revisionId: id });
  } else {
    await tx
      .update(resourceHeads)
      .set({ revisionId: id })
      .where(eq(resourceHeads.resourceId, resourceId));
  }
  return await hydrate(tx, revision);
}

/**
 * Appends one current object version or saved activity, atomically with projections.
 * The caller must validate the document and authorize the write. Lock multiple
 * canonical IRIs in sorted order before composing several appends in one transaction.
 * This does not publish, change collection membership, or reserve delivery.
 * @returns The stored revision, including protected blind addressing.
 */
export async function appendResourceRevision(
  db: Database | Transaction,
  input: AppendResourceRevisionInput,
): Promise<StoredResourceRevision> {
  const prepared = prepareRevision(input);
  return await db.transaction((tx) => appendPrepared(tx, prepared));
}

/**
 * Loads protected local JSON without applying authorization or stripping bto/bcc.
 * @returns The immutable revision and projections, or null if not found.
 */
export async function loadResourceRevision(
  db: Database | Transaction,
  revisionId: Uuid,
): Promise<StoredResourceRevision | null> {
  const [revision] = await db
    .select()
    .from(resourceRevisions)
    .where(eq(resourceRevisions.id, revisionId))
    .limit(1);
  return revision === undefined ? null : await hydrate(db, revision);
}

/**
 * Loads current protected local state without dereferencing any document target.
 * @returns A snapshot, unavailable record or whiteout, or null when unversioned.
 */
export async function loadCurrentResourceRevision(
  db: Database | Transaction,
  resourceId: Uuid,
): Promise<StoredResourceRevision | null> {
  const revision = await current(db, resourceId);
  return revision === null ? null : await hydrate(db, revision);
}

const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 20;
/**
 * Lists protected history in descending sequence order; authorization belongs to callers.
 * @returns Up to limit revisions strictly before beforeSequence, when supplied.
 */
export async function listResourceRevisions(
  db: Database | Transaction,
  resourceId: Uuid,
  options: { readonly beforeSequence?: number; readonly limit?: number } = {},
): Promise<StoredResourceRevision[]> {
  const { beforeSequence, limit = DEFAULT_HISTORY_LIMIT } = options;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_HISTORY_LIMIT ||
    (beforeSequence !== undefined &&
      (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1))
  ) {
    throw new RangeError("Invalid history bounds.");
  }
  const revisions = await db
    .select()
    .from(resourceRevisions)
    .where(
      and(
        eq(resourceRevisions.resourceId, resourceId),
        beforeSequence === undefined
          ? undefined
          : lt(resourceRevisions.sequence, beforeSequence),
      ),
    )
    .orderBy(desc(resourceRevisions.sequence))
    .limit(limit);
  if (revisions.length === 0) return [];
  const revisionIds = revisions.map(({ id }) => id);
  const [addressing, relations] = await Promise.all([
    db
      .select()
      .from(revisionAddressing)
      .where(inArray(revisionAddressing.revisionId, revisionIds))
      .orderBy(revisionAddressing.property, revisionAddressing.position),
    db
      .select()
      .from(revisionRelations)
      .where(inArray(revisionRelations.revisionId, revisionIds))
      .orderBy(revisionRelations.occurrence),
  ]);
  const addressingByRevision = new Map<Uuid, RevisionAddressing[]>();
  for (const row of addressing) {
    const rows = addressingByRevision.get(row.revisionId) ?? [];
    rows.push(row);
    addressingByRevision.set(row.revisionId, rows);
  }
  const relationsByRevision = new Map<Uuid, RevisionRelation[]>();
  for (const row of relations) {
    const rows = relationsByRevision.get(row.revisionId) ?? [];
    rows.push(row);
    relationsByRevision.set(row.revisionId, rows);
  }
  return revisions.map((revision) => ({
    ...revision,
    addressing: addressingByRevision.get(revision.id) ?? [],
    relations: relationsByRevision.get(revision.id) ?? [],
  }));
}

export { captureLegacyResourceRevision } from "./legacy-resource-revision.ts";
