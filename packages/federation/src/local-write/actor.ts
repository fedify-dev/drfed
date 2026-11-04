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
import { type Uuid, validateUuid } from "@drfed/models/uuid";
import { and, eq, gt, inArray, isNotNull, isNull, ne } from "drizzle-orm";

import { instanceUrl } from "../origin.ts";
import {
  type LocalWriteError,
  type WritePrincipal,
  writeError,
} from "./types.ts";

/** A local actor the principal may write as. */
export interface WritingActor {
  readonly id: Uuid;
  readonly iri: string;
  readonly instanceId: Uuid;
  /** The canonical origin of the actor's instance. */
  readonly origin: URL;
}

const actorNotFound = writeError("actor_not_found", "Can't find the actor.");

/**
 * Finds the local actor the principal may write as: a live local actor of an
 * unexpired local instance the principal is an accepted member of.  Inside a
 * transaction, the actor row is locked first, and permission is read by a
 * later statement, so that a membership revoked while this transaction waited
 * for the lock is seen.
 * @returns The actor, or why the principal may not write as it.
 */
export async function findWritingActor(
  db: Database | Transaction,
  rootOrigin: URL,
  principal: WritePrincipal,
  actorId: Uuid,
  lock: boolean,
): Promise<WritingActor | LocalWriteError> {
  if (!validateUuid(actorId)) return actorNotFound;
  if (lock) {
    const [locked] = await db
      .select({ id: schema.actors.id })
      .from(schema.actors)
      .where(eq(schema.actors.id, actorId))
      .for("update");
    if (locked == null) return actorNotFound;
  }
  const [actor] = await db
    .select({
      id: schema.actors.id,
      iri: schema.resources.iri,
      instanceId: schema.instances.id,
      host: schema.instances.host,
    })
    .from(schema.actors)
    .innerJoin(schema.resources, eq(schema.resources.id, schema.actors.id))
    .innerJoin(
      schema.instances,
      eq(schema.actors.instanceId, schema.instances.id),
    )
    .innerJoin(
      schema.localInstances,
      eq(schema.instances.localId, schema.localInstances.id),
    )
    .innerJoin(
      schema.instanceMembers,
      eq(schema.instanceMembers.instanceId, schema.instances.id),
    )
    .where(
      and(
        eq(schema.actors.id, actorId),
        isNotNull(schema.actors.localId),
        isNull(schema.actors.deleted),
        gt(schema.localInstances.expires, Temporal.Now.instant()),
        eq(schema.instanceMembers.accountId, principal.accountId),
        isNotNull(schema.instanceMembers.accepted),
      ),
    )
    .limit(1);
  if (actor == null) return actorNotFound;
  // Stored authorities can outlive the runtime that accepted them.
  const origin = `${rootOrigin.protocol}//${actor.host}`;
  if (!URL.canParse(origin)) {
    return writeError(
      "invalid_instance_host",
      `The instance host ${JSON.stringify(actor.host)} cannot be parsed by ` +
        "this server. Contact the server administrator.",
    );
  }
  return {
    id: actor.id,
    iri: actor.iri,
    instanceId: actor.instanceId,
    origin: instanceUrl(rootOrigin, actor.host, "/"),
  };
}

/**
 * Finds which IRIs name live local actors of an instance.
 * @returns The IRIs among those given that do.
 */
export async function localActorIris(
  db: Database | Transaction,
  instanceId: Uuid,
  iris: readonly string[],
): Promise<ReadonlySet<string>> {
  if (iris.length === 0) return new Set();
  const rows = await db
    .select({ iri: schema.resources.iri })
    .from(schema.actors)
    .innerJoin(schema.resources, eq(schema.resources.id, schema.actors.id))
    .where(
      and(
        inArray(schema.resources.iri, [...iris]),
        eq(schema.actors.instanceId, instanceId),
        isNotNull(schema.actors.localId),
        isNull(schema.actors.deleted),
      ),
    );
  return new Set(rows.map(({ iri }) => iri));
}

/**
 * Finds which IRIs are registered resources of a known kind.  A resource of
 * the `unknown` kind was only registered because a document referred to it,
 * as an addressing or relation target, so it proves nothing about the IRI.
 * @returns The IRIs among those given that are.
 */
export async function registeredIris(
  db: Database | Transaction,
  iris: readonly string[],
): Promise<ReadonlySet<string>> {
  if (iris.length === 0) return new Set();
  const rows = await db
    .select({ iri: schema.resources.iri })
    .from(schema.resources)
    .where(
      and(
        inArray(schema.resources.iri, [...iris]),
        ne(schema.resources.kind, "unknown"),
      ),
    );
  return new Set(rows.map(({ iri }) => iri));
}
