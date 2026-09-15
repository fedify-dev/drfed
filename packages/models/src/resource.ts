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

import { eq } from "drizzle-orm";

import type { Database, Transaction } from "./db.ts";
import {
  type AddressingProperty,
  type Resource,
  addressing,
  addressingPropertyEnum,
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
 * Atomically promotes an unknown IRI and inserts its typed row.
 * @returns The typed-row insertion callback result.
 */
export async function promoteResource<T>(
  db: Database | Transaction,
  iri: string,
  kind: Exclude<Resource["kind"], "unknown">,
  insert: (tx: Transaction, resource: Resource) => Promise<T>,
  id?: Uuid,
): Promise<T> {
  return await db.transaction(async (tx) => {
    const ensured = await ensureResource(tx, iri, id);
    // Only promotion needs an exclusive lock; re-read the kind after locking
    // so a concurrent promotion cannot change it between validation and update.
    const [resource] = await tx
      .select()
      .from(resources)
      .where(eq(resources.id, ensured.id))
      .for("update");
    if (resource == null) {
      throw new Error("Resource disappeared during promotion.");
    }
    if (resource.kind !== "unknown" && resource.kind !== kind) {
      throw new Error(`Resource ${iri} is already a ${resource.kind}.`);
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
