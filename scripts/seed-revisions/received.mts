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

// Keep dependent database writes sequential.
// oxlint-disable no-await-in-loop

import type { JsonObject } from "@drfed/federation/local-write";
import { type Database, schema } from "@drfed/models";
import { ensureResource } from "@drfed/models/resource";
import {
  appendResourceRevision,
  loadCurrentResourceRevision,
} from "@drfed/models/resource-revision";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";

import type { Workspace } from "./environment.mts";
import { AS } from "./writer.mts";

/** A remote `Note` as an inbound delivery would carry it. */
export interface ReceivedNote {
  readonly iri: string;
  readonly attributedTo: string;
  readonly content: string;
  readonly to: readonly string[];
  /** The workspaces whose inboxes received it. */
  readonly deliveredTo: readonly Workspace[];
}

/**
 * Stores a version of a remote `Note` as a received revision, with a receipt
 * for each workspace it was delivered to.  No write path stores received
 * documents as revisions yet, so the rows are written directly.
 * @returns The note's resource ID and the new revision's ID.
 */
export async function receiveNote(
  db: Database,
  { iri, attributedTo, content, to, deliveredTo }: ReceivedNote,
): Promise<{ resourceId: Uuid; revisionId: Uuid; document: JsonObject }> {
  const resource = await ensureResource(db, iri);
  const current = await loadCurrentResourceRevision(db, resource.id);
  const document: JsonObject = {
    "@context": AS,
    id: iri,
    type: "Note",
    attributedTo,
    content,
    to: [...to],
  };
  const revision = await appendResourceRevision(db, {
    resourceId: resource.id,
    resourceKind: "object",
    expectedRevisionId: current?.id ?? null,
    kind: "snapshot",
    capture: "received",
    document,
    addressing: { to: [...to] },
  });
  for (const { instanceId, actorIri } of deliveredTo) {
    const deliveryId = uuidV7();
    await db.insert(schema.activityDeliveries).values({
      id: deliveryId,
      instanceId,
      direction: "inbound",
      status: "received",
      verificationResult: "verified",
      inboxUrl: `${actorIri}/inbox`,
      body: Buffer.from(JSON.stringify(document)),
      completed: Temporal.Now.instant(),
    });
    await db
      .insert(schema.revisionReceipts)
      .values({ deliveryId, revisionId: revision.id, role: "object" });
  }
  return { resourceId: resource.id, revisionId: revision.id, document };
}
