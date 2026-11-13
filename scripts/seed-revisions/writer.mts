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
  type CreateRequest,
  type EmbeddedSource,
  type JsonObject,
  type LocalWriteEnvironment,
  type LocalWriteRequest,
  type LocalWriteResult,
  type SavedResource,
  commitLocalWrite,
  previewLocalWrite,
} from "@drfed/federation/local-write";
import type { Database } from "@drfed/models";
import { loadCurrentResourceRevision } from "@drfed/models/resource-revision";
import type { Uuid } from "@drfed/models/uuid";

import type { Workspace } from "./environment.mts";

export const AS = "https://www.w3.org/ns/activitystreams";
export const ACTIVITY: CreateRequest["resources"] = [
  { path: [], kind: "activity" },
];
const OBJECT: CreateRequest["resources"] = [{ path: [], kind: "object" }];

/** The current snapshot of a resource. */
export interface Head {
  readonly revisionId: Uuid;
  readonly document: JsonObject;
}

/** Local writes of one actor, through the common write operations. */
export interface Writer {
  /** Saves new resources. @returns The root resource, saved last. */
  save(
    document: JsonObject,
    resources?: CreateRequest["resources"],
    sources?: readonly EmbeddedSource[],
  ): Promise<SavedResource>;
  /** Saves new resources. @returns All of them, the root last. */
  saveAll(
    document: JsonObject,
    resources: CreateRequest["resources"],
    sources?: readonly EmbeddedSource[],
  ): Promise<readonly SavedResource[]>;
  /** Edits an object by changing its current document. */
  edit(objectId: Uuid, changes: JsonObject): Promise<void>;
  /** Deletes an object, appending a whiteout. */
  remove(objectId: Uuid): Promise<void>;
}

/**
 * Drops the `@context` of a stored document, to embed it in another.
 * @returns The rest of the document.
 */
export const withoutContext = ({
  "@context": _,
  ...rest
}: JsonObject): JsonObject => rest;

/**
 * Reads the current snapshot of a resource.
 * @returns Its revision ID and document.
 */
export async function loadHead(db: Database, resourceId: Uuid): Promise<Head> {
  const revision = await loadCurrentResourceRevision(db, resourceId);
  if (revision?.document == null) {
    throw new Error(`Resource ${resourceId} has no current snapshot.`);
  }
  return {
    revisionId: revision.id,
    document: revision.document as JsonObject,
  };
}

/**
 * Makes the writer of a workspace's actor.  Nothing it saves is delivered:
 * edits and deletions get a reservation that does nothing.
 * @returns The writer.
 */
export function createWriter(
  env: LocalWriteEnvironment,
  { actorId, member }: Workspace,
): Writer {
  const principal = { accountId: member.accountId };
  const commit = async (
    request: LocalWriteRequest,
  ): Promise<LocalWriteResult> => {
    const preview = await previewLocalWrite(env, principal, request);
    if (!preview.ok) throw new Error(JSON.stringify(preview.error));
    const outcome = await commitLocalWrite(env, principal, request, {
      previewToken: preview.preview.token,
      ...(request.operation === "create"
        ? {}
        : { reserveDispatch: () => Promise.resolve() }),
    });
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.error));
    return outcome.result;
  };
  const saveAll: Writer["saveAll"] = async (document, resources, sources) => {
    const result = await commit({
      operation: "create",
      actorId,
      document: { "@context": AS, ...document },
      resources,
      ...(sources == null ? {} : { sources }),
    });
    return result.resources;
  };
  return {
    saveAll,
    async save(document, resources, sources) {
      const saved = (await saveAll(document, resources ?? OBJECT, sources)).at(
        -1,
      );
      if (saved == null) throw new Error("Nothing was saved.");
      return saved;
    },
    async edit(objectId, changes) {
      const head = await loadHead(env.db, objectId);
      await commit({
        operation: "edit",
        actorId,
        objectId,
        expectedRevisionId: head.revisionId,
        document: { ...head.document, ...changes },
      });
    },
    async remove(objectId) {
      const head = await loadHead(env.db, objectId);
      await commit({
        operation: "delete",
        actorId,
        objectId,
        expectedRevisionId: head.revisionId,
      });
    },
  };
}
