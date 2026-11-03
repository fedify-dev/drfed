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
import type { Diagnostic, NormalizationChange } from "@drfed/models/document";
import {
  ResourceKindConflictError,
  addActorCollectionItem,
  ensureResource,
  lockActorCollection,
  lockResources,
  replaceAddressing,
  storeAddressingOccurrences,
} from "@drfed/models/resource";
import {
  LegacyResourceRevisionError,
  ResourceRevisionStateError,
  RevisionConflictError,
  appendResourceRevision,
  writeTypedResourceRevision,
} from "@drfed/models/resource-revision";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";
import { inArray } from "drizzle-orm";

import {
  type WritingActor,
  findWritingActor,
  localActorIris,
  registeredIris,
} from "./actor.ts";
import {
  type WriteTarget,
  bindableExisting,
  checkExistingRequest,
  currentAddressing,
  generatedKey,
  loadTarget,
  prepareDelete,
  prepareEdit,
} from "./existing.ts";
import {
  type IdentityLookups,
  allocate,
  bindableRequest,
  checkCreateRequest,
  prepareCreate,
} from "./prepare.ts";
import {
  type Allocation,
  digestRequest,
  issueToken,
  readToken,
  toMicroseconds,
} from "./token.ts";
import type { TypedProjection } from "./typed.ts";
import {
  type CommitOptions,
  type CommitOutcome,
  type LocalWriteEnvironment,
  type LocalWriteError,
  type LocalWriteRequest,
  LocalWriteRollback,
  type PreparedResource,
  type PreviewOutcome,
  type SavedResource,
  type WritePrincipal,
  isLocalWriteError,
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

function checkRequest(request: LocalWriteRequest): LocalWriteError | null {
  if (request === null || typeof request !== "object") {
    return writeError("invalid_request", "Expected a write request.");
  }
  switch (request.operation) {
    case "create":
      return checkCreateRequest(request);
    case "edit":
    case "delete":
      return checkExistingRequest(request);
    default:
      return writeError("invalid_request", "Unknown write operation.");
  }
}

function bindable(request: LocalWriteRequest): unknown {
  return request.operation === "create"
    ? bindableRequest(request)
    : bindableExisting(request);
}

function allocateFor(request: LocalWriteRequest): Allocation {
  return request.operation === "create"
    ? allocate(request.resources)
    : {
        ids: new Map([[generatedKey, uuidV7()]]),
        timestamp: toMicroseconds(Temporal.Now.instant()),
      };
}

/** A prepared write of any operation. */
interface PreparedOperation {
  readonly diagnostics: readonly Diagnostic[];
  readonly changes: readonly NormalizationChange[];
  readonly resources: readonly PreparedResource[];
  /** The object an edit or deletion acts on. */
  readonly target?: WriteTarget;
  /** An edit's typed columns, when the object has a typed row. */
  readonly typed?: TypedProjection | null;
}

async function prepare(
  env: LocalWriteEnvironment,
  db: Database | Transaction,
  actor: WritingActor,
  request: LocalWriteRequest,
  allocation: Allocation,
): Promise<PreparedOperation | LocalWriteError> {
  if (request.operation === "create") {
    return await prepareCreate(
      env.federation,
      env.rootOrigin,
      actor,
      request,
      allocation,
      lookups(db, actor),
    );
  }
  const target = await loadTarget(
    db,
    actor,
    request.objectId,
    request.expectedRevisionId,
  );
  if (isLocalWriteError(target)) return target;
  const change =
    request.operation === "edit"
      ? await prepareEdit(
          env.federation,
          env.rootOrigin,
          actor,
          target,
          request,
          allocation,
          lookups(db, actor),
        )
      : await prepareDelete(env.federation, actor, target, allocation, () =>
          currentAddressing(db, target.id),
        );
  if (isLocalWriteError(change)) return change;
  if (change.object == null) {
    return { ...change, resources: [change.activity], target };
  }
  const { typed, ...object } = change.object;
  return { ...change, resources: [object, change.activity], target, typed };
}

/**
 * Previews a write: checks permission and the document, and shows every
 * value the server will add, including new IRIs and timestamps, and for an
 * edit or deletion the generated activity, with a token that commits
 * exactly them.  It writes nothing and holds no lock; a preview grants no
 * permission.
 * @returns The preview, or why the write cannot happen.
 */
export async function previewLocalWrite(
  env: LocalWriteEnvironment,
  principal: WritePrincipal,
  request: LocalWriteRequest,
): Promise<PreviewOutcome> {
  const requestError = checkRequest(request);
  if (requestError != null) return { ok: false, error: requestError };
  const actor = await findWritingActor(
    env.db,
    env.rootOrigin,
    principal,
    request.actorId,
    false,
  );
  if (isLocalWriteError(actor)) return { ok: false, error: actor };
  const allocation = allocateFor(request);
  const prepared = await prepare(env, env.db, actor, request, allocation);
  if (isLocalWriteError(prepared)) return { ok: false, error: prepared };
  const token = await issueToken(
    env.previewKey,
    principal.accountId,
    await digestRequest(bindable(request)),
    allocation,
  );
  const { diagnostics, changes, resources, target } = prepared;
  return {
    ok: true,
    preview: {
      diagnostics,
      changes,
      resources,
      ...(target == null ? {} : { currentRevisionId: target.head.id }),
      token,
    },
  };
}

async function writeObjectVersion(
  tx: Transaction,
  target: WriteTarget,
  object: PreparedResource,
  typed: TypedProjection | null | undefined,
): Promise<Uuid> {
  if (target.typed != null && typed != null) {
    const { attributedTo: _, ...columns } = typed;
    const revision = await writeTypedResourceRevision(tx, {
      resourceId: target.id,
      expectedRevisionId: target.head.id,
      kind: "snapshot",
      document: object.document,
      columns,
      addressingOccurrences: object.addressing,
      relations: object.relations,
    });
    return revision.id;
  }
  const revision = await appendResourceRevision(tx, {
    resourceId: target.id,
    resourceKind: "object",
    expectedRevisionId: target.head.id,
    kind: "snapshot",
    document: object.document,
    capture: "local",
    addressingOccurrences: object.addressing,
    relations: object.relations,
  });
  await replaceAddressing(tx, target.id, object.addressing);
  return revision.id;
}

async function writeWhiteout(
  tx: Transaction,
  target: WriteTarget,
  deleted: Temporal.Instant,
): Promise<Uuid> {
  // Former types keep the spelling of ActivityStreams types, as legacy
  // whiteouts do, whatever key named the type.
  const prefix = "https://www.w3.org/ns/activitystreams#";
  const formerTypes = [
    target.type.startsWith(prefix)
      ? target.type.slice(prefix.length)
      : target.type,
  ];
  const revision =
    target.typed == null
      ? await appendResourceRevision(tx, {
          resourceId: target.id,
          resourceKind: "object",
          expectedRevisionId: target.head.id,
          kind: "whiteout",
          deleted,
          formerTypes,
        })
      : await writeTypedResourceRevision(tx, {
          resourceId: target.id,
          expectedRevisionId: target.head.id,
          kind: "whiteout",
          deleted,
          formerTypes,
        });
  return revision.id;
}

function conflictError(request: LocalWriteRequest): LocalWriteError {
  return request.operation === "create"
    ? writeError(
        "resource_conflict",
        "Another write saved these resources first; preview a new write.",
      )
    : writeError(
        "revision_conflict",
        "The object changed after it was loaded; load it again.",
      );
}

/**
 * Commits a previewed write in one transaction: it checks permission again
 * under the actor's lock, prepares the document again with the token's
 * values, and saves every new resource with its revision and indexes; an
 * edit or deletion also changes the current object and saves the generated
 * activity in the actor's outbox.  Any failure leaves nothing.  Saving never
 * delivers anything; publishing, editing, and deleting add an activity to the
 * outbox and require `reserveDispatch`.
 * @returns The saved resources, or why nothing was saved.
 */
export async function commitLocalWrite(
  env: LocalWriteEnvironment,
  principal: WritePrincipal,
  request: LocalWriteRequest,
  options: CommitOptions,
): Promise<CommitOutcome> {
  const requestError = checkRequest(request);
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
  const outboxed = request.operation !== "create" || request.publish === true;
  if (outboxed && typeof options.reserveDispatch !== "function") {
    return {
      ok: false,
      error: writeError(
        "invalid_request",
        "Publishing, editing, and deleting require a dispatch reservation.",
      ),
    };
  }
  const allocation = await readToken(
    env.previewKey,
    options.previewToken,
    principal.accountId,
    await digestRequest(bindable(request)),
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
      if (isLocalWriteError(actor)) fail(actor);
      const writer = actor as WritingActor;
      if (outboxed) await lockActorCollection(tx, writer.id, "outbox");
      const prepared = await prepare(env, tx, writer, request, allocation);
      if (isLocalWriteError(prepared)) fail(prepared);
      const { resources, target, typed } = prepared as PreparedOperation;
      const created = resources.filter(
        ({ id }) => target == null || id !== target.id,
      );
      const newIris = created.map(({ iri }) => iri);
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
      const ids = new Map(created.map(({ iri, id }) => [iri, id]));
      const iris = new Set([
        ...newIris,
        ...resources.flatMap(({ addressing }) =>
          addressing.map(({ iri }) => iri),
        ),
      ]);
      for (const iri of [...iris].sort()) {
        await ensureResource(tx, iri, ids.get(iri));
      }
      await lockResources(tx, [
        ...newIris,
        ...(target == null ? [] : [target.iri]),
      ]);
      const saved: SavedResource[] = [];
      let whiteoutRevisionId: Uuid | undefined;
      if (request.operation === "delete") {
        whiteoutRevisionId = await writeWhiteout(
          tx,
          target!,
          allocation.timestamp,
        );
      }
      for (const resource of resources) {
        if (target != null && resource.id === target.id) {
          const revisionId = await writeObjectVersion(
            tx,
            target,
            resource,
            typed,
          );
          saved.push({ ...resource, revisionId });
          continue;
        }
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
      if (outboxed) {
        const activity = saved.at(-1)!;
        await addActorCollectionItem(tx, writer.id, "outbox", activity.id);
        await options.reserveDispatch!(tx, activity);
      }
      return {
        resources: saved,
        published: outboxed,
        ...(whiteoutRevisionId == null ? {} : { whiteoutRevisionId }),
      };
    });
    return { ok: true, result };
  } catch (error) {
    if (error instanceof LocalWriteRollback) {
      return { ok: false, error: error.error };
    }
    if (error instanceof RevisionConflictError) {
      return { ok: false, error: conflictError(request) };
    }
    if (error instanceof ResourceKindConflictError) {
      return {
        ok: false,
        error: writeError(
          "resource_conflict",
          "Another write saved these resources first; preview a new write.",
        ),
      };
    }
    if (
      error instanceof LegacyResourceRevisionError ||
      error instanceof ResourceRevisionStateError
    ) {
      return {
        ok: false,
        error: writeError(
          "unsupported_edit",
          "The object's current state cannot be changed safely.",
        ),
      };
    }
    throw error;
  }
}
