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

import type { Database } from "@drfed/models";
import type { AddressedActor } from "@drfed/models/activity-log";
import type { Uuid } from "@drfed/models/uuid";
import { type Activity, PUBLIC_COLLECTION } from "@fedify/vocab";

/**
 * The IRIs an activity addresses, without Public.
 * @returns The distinct addressed IRIs.
 */
export function addressedIris(activity: Activity | null): string[] {
  if (activity == null) return [];
  const iris = [
    ...activity.toIds,
    ...activity.btoIds,
    ...activity.ccIds,
    ...activity.bccIds,
    ...activity.audienceIds,
  ].map((iri) => iri.href);
  return [...new Set(iris)].filter((iri) => iri !== PUBLIC_COLLECTION.href);
}

/**
 * Resolve addressed IRIs to local actors, directly or through stored
 * collection membership.
 * @returns One entry per way an actor is reached.
 */
export async function findAddressedActors(
  db: Database,
  instanceId: Uuid,
  iris: readonly string[],
): Promise<AddressedActor[]> {
  if (iris.length === 0) return [];
  const local = {
    instanceId,
    localId: { isNotNull: true },
    deleted: { isNull: true },
  } as const;
  const direct = await db.query.actors.findMany({
    columns: { id: true },
    where: { ...local, resource: { iri: { in: [...iris] } } },
  });
  const collections = await db.query.collections.findMany({
    columns: { id: true },
    where: { resource: { iri: { in: [...iris] } } },
    with: {
      resource: { columns: { iri: true } },
      items: {
        columns: { itemId: true },
        where: { item: { actor: local } },
      },
    },
  });
  return [
    ...direct.map(({ id }) => ({ actorId: id })),
    ...collections.flatMap(({ resource, items }) =>
      items.map(({ itemId }) => ({
        actorId: itemId,
        viaCollectionIri: resource.iri,
      })),
    ),
  ];
}
