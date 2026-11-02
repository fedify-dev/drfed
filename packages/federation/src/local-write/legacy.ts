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

import { schema } from "@drfed/models";
import {
  type AddressingInput,
  addActorCollectionItem,
  ensureResource,
  lockActorCollection,
  promoteResource,
  storeAddressing,
} from "@drfed/models/resource";
import { captureLegacyResourceRevision } from "@drfed/models/resource-revision";
import type { ActivityPubObject, ObjectType } from "@drfed/models/schema";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";
import { Object as APObject, Create } from "@fedify/vocab";
import { eq } from "drizzle-orm";

import {
  activitySelection,
  objectSelection,
  toCreate,
  toObject,
} from "../object.ts";
import { type WritingActor, findWritingActor } from "./actor.ts";
import type {
  LocalWriteEnvironment,
  LocalWriteError,
  WritePrincipal,
} from "./types.ts";

/** The fields the legacy object creation stores, already checked. */
export interface LegacyObjectInput {
  readonly actorId: Uuid;
  readonly type: ObjectType;
  /** Non-empty HTML, stored verbatim. */
  readonly contentHtml: string;
  readonly name: string | null;
  readonly summary: string | null;
  /** A canonical BCP 47 tag of at most 35 characters. */
  readonly language: string | null;
  readonly sensitive: boolean;
  readonly addressing: AddressingInput;
}

/** The object the legacy creation stored, with its author and snapshot. */
export type LegacyObject = ActivityPubObject & {
  readonly actor: NonNullable<Awaited<ReturnType<typeof loadObject>>>["actor"];
  readonly document: Record<string, unknown>;
};

async function loadObject(
  tx: Parameters<Parameters<LocalWriteEnvironment["db"]["transaction"]>[0]>[0],
  id: Uuid,
) {
  return await tx.query.objects.findFirst({
    where: { id },
    with: objectSelection,
  });
}

function asDocument(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a JSON-LD object.");
  }
  return value as Record<string, unknown>;
}

function isError(value: object): value is LocalWriteError {
  return "type" in value && "diagnostics" in value;
}

/**
 * Creates a Note or Article together with a `Create` in the actor's outbox,
 * without delivering it, exactly as the `createObject` mutation always has:
 * typed rows, documents serialized by {@link toObject} and {@link toCreate}
 * with blind recipients kept, and their first revisions.  It shares
 * permission checks and locking with the common write operations, but takes
 * no preview and runs no document validation, because its input is not a
 * submitted document.  New editors use `commitLocalWrite()` instead.
 * @returns The stored object, or why the actor may not write.
 */
export async function createLegacyObject(
  env: Pick<LocalWriteEnvironment, "db" | "federation" | "rootOrigin">,
  principal: WritePrincipal,
  input: LegacyObjectInput,
): Promise<LegacyObject | LocalWriteError> {
  const { actorId, addressing, ...values } = input;
  return await env.db.transaction(async (tx) => {
    // Keep host validation and resource creation under the same actor lock.
    const found = await findWritingActor(
      tx,
      env.rootOrigin,
      principal,
      actorId,
      true,
    );
    // Nothing is written yet, so returning a failure commits nothing.
    if (isError(found)) return found;
    const actor: WritingActor = found;
    await lockActorCollection(tx, actorId, "outbox");
    const published = Temporal.Now.instant();
    const id = uuidV7();
    const fedCtx = env.federation.createContext(actor.origin, undefined);
    const iri = fedCtx.getObjectUri(APObject, { identifier: actorId, id }).href;
    const activityId = uuidV7();
    const activityIri = fedCtx.getObjectUri(Create, { id: activityId }).href;
    await ensureResource(tx, activityIri, activityId);
    const object = await promoteResource(
      tx,
      iri,
      "object",
      async (inner, resource) => {
        const [row] = await inner
          .insert(schema.objects)
          .values({
            ...values,
            id: resource.id,
            actorId,
            activityId,
            published,
          })
          .returning();
        if (row == null) {
          throw new Error("Object insertion returned no row.");
        }
        return row;
      },
      id,
    );
    await storeAddressing(tx, object.id, addressing);
    await promoteResource(
      tx,
      activityIri,
      "activity",
      async (inner, resource) => {
        await inner.insert(schema.activities).values({
          id: resource.id,
          type: "Create",
          actorId,
          objectId: object.id,
          published: object.published,
        });
        await storeAddressing(inner, resource.id, addressing);
        await addActorCollectionItem(inner, actorId, "outbox", resource.id);
      },
      activityId,
    );
    const storedObject = await loadObject(tx, object.id);
    const storedActivity = await tx.query.activities.findFirst({
      where: { id: activityId },
      with: activitySelection,
    });
    if (storedObject == null || storedActivity == null) {
      throw new Error("Missing newly created resource.");
    }
    // Preserve blind recipients in the local snapshot; serving strips them.
    const snapshot = {
      ...asDocument(await toObject(fedCtx, storedObject).toJsonLd()),
      ...addressing,
    };
    await tx
      .update(schema.objects)
      .set({ document: snapshot, updated: object.updated })
      .where(eq(schema.objects.id, object.id));
    await tx
      .update(schema.activities)
      .set({
        document: {
          ...asDocument(await toCreate(fedCtx, storedActivity).toJsonLd()),
          ...addressing,
        },
      })
      .where(eq(schema.activities.id, activityId));
    await captureLegacyResourceRevision(tx, object.id);
    await captureLegacyResourceRevision(tx, activityId);
    return { ...object, actor: storedObject.actor, document: snapshot };
  });
}
