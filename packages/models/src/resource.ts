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

// Keep dependent database writes and observations sequential.
// oxlint-disable no-await-in-loop

import { and, asc, eq, inArray, min } from "drizzle-orm";

import type { Database, Transaction } from "./db.ts";
import {
  type AddressingProperty,
  type CollectionRole,
  type Resource,
  actorCollectionReferences,
  addressing,
  addressingPropertyEnum,
  collectionItems,
  collections,
  resources,
} from "./schema.ts";
import { type Uuid, uuidV7 } from "./uuid.ts";

export const PUBLIC_IRI = "https://www.w3.org/ns/activitystreams#Public";
export const PUBLIC_RESOURCE_ID: Uuid = "00000000-0000-4000-8000-000000000000";

/**
 * Returns the canonical resource without interpreting or normalizing its IRI.
 * @returns The existing or newly registered resource.
 */
export async function ensureResource(
  tx: Database | Transaction,
  iri: string,
  id = uuidV7(),
): Promise<Resource> {
  const [existing] = await tx
    .select()
    .from(resources)
    .where(eq(resources.iri, iri))
    .limit(1);
  if (existing != null) return existing;
  const [inserted] = await tx
    .insert(resources)
    .values({ id, iri, kind: "unknown" })
    .onConflictDoNothing({ target: resources.iri })
    .returning();
  if (inserted != null) return inserted;
  // A concurrent insertion can win after the first SELECT. A separate
  // statement sees that committed row under PostgreSQL's READ COMMITTED.
  const [resource] = await tx
    .select()
    .from(resources)
    .where(eq(resources.iri, iri))
    .limit(1);
  if (resource == null) throw new Error("Resource insertion returned no row.");
  return resource;
}

/**
 * Promotions of one resource exclude each other, but not the foreign key
 * checks of rows referring to it, such as addressing it: `kind` is no key.
 * An exclusive lock would make two writers that each promote one resource and
 * address the other deadlock.
 */
const PROMOTION_LOCK = "no key update";

/**
 * Locks resources for promotion in IRI order, so that transactions promoting
 * several of them never wait for each other in a cycle.  Only registered IRIs
 * are locked; see {@link ensureResource}.
 */
export async function lockResources(
  tx: Transaction,
  iris: readonly string[],
): Promise<void> {
  if (iris.length === 0) return;
  // PostgreSQL locks the rows after sorting them.
  await tx
    .select({ id: resources.id })
    .from(resources)
    .where(inArray(resources.iri, [...iris]))
    .orderBy(asc(resources.iri))
    .for(PROMOTION_LOCK);
}

/** Thrown when an IRI is already registered as another kind of resource. */
export class ResourceKindConflictError extends Error {
  constructor(
    readonly iri: string,
    readonly kind: Resource["kind"],
    readonly requested: Exclude<Resource["kind"], "unknown">,
  ) {
    super(`Resource ${iri} is already a ${kind}.`);
    this.name = "ResourceKindConflictError";
  }
}

/**
 * Atomically promotes an unknown IRI and inserts its typed row.  An IRI that
 * already is of the kind is passed to `reuse` instead, under the same lock, so
 * that concurrent writers of one IRI insert its typed row once.
 * @returns The typed-row insertion or reuse callback result.
 * @throws {ResourceKindConflictError} If the IRI is another kind of resource.
 * @throws {Error} If the IRI already is of the kind and `reuse` is not given.
 */
export async function promoteResource<T>(
  db: Database | Transaction,
  iri: string,
  kind: Exclude<Resource["kind"], "unknown">,
  insert: (tx: Transaction, resource: Resource) => Promise<T>,
  id?: Uuid,
  reuse?: (tx: Transaction, resource: Resource) => Promise<T>,
): Promise<T> {
  return await db.transaction(async (tx) => {
    const ensured = await ensureResource(tx, iri, id);
    // Re-read the kind after locking so a concurrent promotion cannot change
    // it between validation and update.
    const [resource] = await tx
      .select()
      .from(resources)
      .where(eq(resources.id, ensured.id))
      .for(PROMOTION_LOCK);
    if (resource == null) {
      throw new Error("Resource disappeared during promotion.");
    }
    if (resource.kind === kind) {
      if (reuse == null) {
        throw new Error(`Resource ${iri} has already been promoted.`);
      }
      return await reuse(tx, resource);
    }
    if (resource.kind !== "unknown") {
      throw new ResourceKindConflictError(iri, resource.kind, kind);
    }
    await tx
      .update(resources)
      .set({ kind })
      .where(eq(resources.id, resource.id));
    return await insert(tx, { ...resource, kind });
  });
}

export type AddressingInput = Readonly<
  Partial<Record<AddressingProperty, readonly string[]>>
>;

/** Stores every occurrence, including duplicates, in its original position. */
export async function storeAddressing(
  tx: Transaction,
  sourceId: Uuid,
  input: AddressingInput,
): Promise<void> {
  // Acquire unique-index locks for new IRIs in a consistent order across
  // writers. This does not change occurrence order in the addressing rows.
  const targets = new Map<string, Resource>();
  const iris = [
    ...new Set(
      addressingPropertyEnum.enumValues.flatMap(
        (property) => input[property] ?? [],
      ),
    ),
  ].sort();
  for (const iri of iris) targets.set(iri, await ensureResource(tx, iri));
  for (const property of addressingPropertyEnum.enumValues) {
    for (const [position, iri] of (input[property] ?? []).entries()) {
      const target = targets.get(iri)!;
      await tx.insert(addressing).values({
        id: uuidV7(),
        sourceId,
        property,
        position,
        targetId: target.id,
      });
    }
  }
}

/**
 * Locks an actor's declared collection until the transaction ends.
 * @returns The locked collection ID.
 */
export async function lockActorCollection(
  tx: Transaction,
  actorId: Uuid,
  role: CollectionRole,
): Promise<Uuid> {
  const [reference] = await tx
    .select({ collectionId: collections.id })
    .from(collections)
    .innerJoin(
      actorCollectionReferences,
      eq(collections.id, actorCollectionReferences.collectionId),
    )
    .where(
      and(
        eq(actorCollectionReferences.actorId, actorId),
        eq(actorCollectionReferences.role, role),
      ),
    )
    .for("update", { of: collections })
    .limit(1);
  if (reference == null) {
    throw new Error(`Actor ${actorId} declares no ${role} collection.`);
  }
  return reference.collectionId;
}

/**
 * Records a resource in an actor's declared collection, idempotently.
 * Position ASC is presentation order. Outboxes are reverse chronological,
 * so the newest item receives the smallest position.
 * @throws {Error} If the actor declares no collection for the role.
 */
export async function addActorCollectionItem(
  db: Database | Transaction,
  actorId: Uuid,
  role: CollectionRole,
  itemId: Uuid,
): Promise<void> {
  await db.transaction(async (tx) => {
    const collectionId = await lockActorCollection(tx, actorId, role);
    const [row] = await tx
      .select({ position: min(collectionItems.position) })
      .from(collectionItems)
      .where(eq(collectionItems.collectionId, collectionId));
    await tx
      .insert(collectionItems)
      .values({ collectionId, itemId, position: (row?.position ?? 0) - 1 })
      .onConflictDoNothing();
  });
}
