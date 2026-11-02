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

// Writes of one transaction stay sequential.
// oxlint-disable no-await-in-loop

import { type Database, type Transaction, schema } from "@drfed/models";
import {
  ResourceKindConflictError,
  addActorCollectionItem,
  ensureResource,
  lockActorCollection,
  lockResources,
  storeAddressingOccurrences,
} from "@drfed/models/resource";
import {
  RevisionConflictError,
  appendResourceRevision,
} from "@drfed/models/resource-revision";
import { inArray } from "drizzle-orm";

import {
  type WritingActor,
  findWritingActor,
  localActorIris,
  registeredIris,
} from "./actor.ts";
import {
  type IdentityLookups,
  allocate,
  bindableRequest,
  checkCreateRequest,
  prepareCreate,
} from "./prepare.ts";
import { digestRequest, issueToken, readToken } from "./token.ts";
import {
  type CommitOptions,
  type CommitOutcome,
  type LocalWriteEnvironment,
  type LocalWriteError,
  type LocalWriteRequest,
  LocalWriteRollback,
  type PreviewOutcome,
  type SavedResource,
  type WritePrincipal,
  writeError,
} from "./types.ts";

function lookups(
  db: Database | Transaction,
  actor: WritingActor,
): IdentityLookups {
  return {
    localActors: (iris) => localActorIris(db, actor.instanceId, iris),
    registered: (iris) => registeredIris(db, iris),
  };
}

function isError(value: object): value is LocalWriteError {
  return "type" in value && "diagnostics" in value;
}

/**
 * Previews a write: checks permission and the document, and shows every
 * value the server will add, including new IRIs and timestamps, with a
 * token that commits exactly them.  It writes nothing and holds no lock; a
 * preview grants no permission.
 * @returns The preview, or why the write cannot happen.
 */
export async function previewLocalWrite(
  env: LocalWriteEnvironment,
  principal: WritePrincipal,
  request: LocalWriteRequest,
): Promise<PreviewOutcome> {
  const requestError = checkCreateRequest(request);
  if (requestError != null) return { ok: false, error: requestError };
  const actor = await findWritingActor(
    env.db,
    env.rootOrigin,
    principal,
    request.actorId,
    false,
  );
  if (isError(actor)) return { ok: false, error: actor };
  const allocation = allocate(request.resources);
  const prepared = await prepareCreate(
    env.federation,
    env.rootOrigin,
    actor,
    request,
    allocation,
    lookups(env.db, actor),
  );
  if (isError(prepared)) return { ok: false, error: prepared };
  const token = await issueToken(
    env.previewKey,
    principal.accountId,
    await digestRequest(bindableRequest(request)),
    allocation,
  );
  return { ok: true, preview: { ...prepared, token } };
}

/**
 * Commits a previewed write in one transaction: it checks permission again
 * under the actor's lock, prepares the document again with the token's
 * values, and saves every new resource with its revision and indexes.  Any
 * failure leaves nothing.  Saving never delivers anything; publishing adds
 * the root activity to the actor's outbox and requires `reserveDispatch`.
 * @returns The saved resources, or why nothing was saved.
 */
export async function commitLocalWrite(
  env: LocalWriteEnvironment,
  principal: WritePrincipal,
  request: LocalWriteRequest,
  options: CommitOptions,
): Promise<CommitOutcome> {
  const requestError = checkCreateRequest(request);
  if (requestError != null) return { ok: false, error: requestError };
  if (
    typeof options?.previewToken !== "string" ||
    options.previewToken === ""
  ) {
    return {
      ok: false,
      error: writeError("invalid_request", "A preview token is required."),
    };
  }
  const publish = request.publish === true;
  if (publish && typeof options.reserveDispatch !== "function") {
    return {
      ok: false,
      error: writeError(
        "invalid_request",
        "Publishing requires a dispatch reservation.",
      ),
    };
  }
  const allocation = await readToken(
    env.previewKey,
    options.previewToken,
    principal.accountId,
    await digestRequest(bindableRequest(request)),
  );
  if (allocation == null) {
    return {
      ok: false,
      error: writeError(
        "stale_preview",
        "The preview is invalid or expired; preview the write again.",
      ),
    };
  }
  try {
    const result = await env.db.transaction(async (tx) => {
      const fail = (error: LocalWriteError): never => {
        throw new LocalWriteRollback(error);
      };
      const actor = await findWritingActor(
        tx,
        env.rootOrigin,
        principal,
        request.actorId,
        true,
      );
      if (isError(actor)) fail(actor);
      const writer = actor as WritingActor;
      if (publish) await lockActorCollection(tx, writer.id, "outbox");
      const prepared = await prepareCreate(
        env.federation,
        env.rootOrigin,
        writer,
        request,
        allocation,
        lookups(tx, writer),
      );
      if (isError(prepared)) fail(prepared);
      const { resources } = prepared as Exclude<
        typeof prepared,
        LocalWriteError
      >;
      const newIris = resources.map(({ iri }) => iri);
      const [existing] = await tx
        .select({ id: schema.resources.id })
        .from(schema.resources)
        .where(inArray(schema.resources.iri, newIris))
        .limit(1);
      if (existing != null) {
        fail(
          writeError(
            "resource_conflict",
            "These resources were already saved; preview a new write.",
          ),
        );
      }
      // Register every IRI once, in one order, so that concurrent writers
      // never wait for each other's registrations in a cycle.
      const ids = new Map(resources.map(({ iri, id }) => [iri, id]));
      const iris = new Set([
        ...newIris,
        ...resources.flatMap(({ addressing }) =>
          addressing.map(({ iri }) => iri),
        ),
      ]);
      for (const iri of [...iris].sort()) {
        await ensureResource(tx, iri, ids.get(iri));
      }
      await lockResources(tx, newIris);
      const saved: SavedResource[] = [];
      for (const resource of resources) {
        const revision = await appendResourceRevision(tx, {
          resourceId: resource.id,
          resourceKind: resource.kind,
          expectedRevisionId: null,
          kind: "snapshot",
          document: resource.document,
          capture: "local",
          addressingOccurrences: resource.addressing,
          relations: resource.relations,
        });
        await storeAddressingOccurrences(tx, resource.id, resource.addressing);
        saved.push({ ...resource, revisionId: revision.id });
      }
      if (publish) {
        const root = saved.at(-1)!;
        await addActorCollectionItem(tx, writer.id, "outbox", root.id);
        await options.reserveDispatch!(tx, root);
      }
      return { resources: saved, published: publish };
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof LocalWriteRollback) {
      return { ok: false, error: error.error };
    }
    if (
      error instanceof RevisionConflictError ||
      error instanceof ResourceKindConflictError
    ) {
      return {
        ok: false,
        error: writeError(
          "resource_conflict",
          "Another write saved these resources first; preview a new write.",
        ),
      };
    }
    throw error;
  }
}
