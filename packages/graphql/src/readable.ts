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
import { PUBLIC_IRI } from "@drfed/models/resource";
import {
  type Account,
  activities,
  activityDeliveries,
  actors,
  addressing,
  instanceMembers,
  instances,
  objects,
  resources,
} from "@drfed/models/schema";
import { type Uuid, validateUuid } from "@drfed/models/uuid";
import {
  type SQL,
  type SQLWrapper,
  and,
  eq,
  inArray,
  isNotNull,
  not,
  sql,
} from "drizzle-orm";
import { type PgColumn, alias } from "drizzle-orm/pg-core";

/**
 * The IRIs that address an activity or object to the public: the full one and
 * the compacted forms a JSON-LD document may carry.
 */
export const PUBLIC_IRIS: readonly string[] = [
  PUBLIC_IRI,
  "as:Public",
  "Public",
];

/**
 * Who reads, and the database to decide what they may read in.
 */
export interface Viewer {
  readonly db: Database;
  readonly account?: Account;
}

/**
 * The local instances an account is an accepted member of; pending members,
 * who have been invited but have not accepted yet, do not count.
 * @returns A query of their IDs.
 */
export const memberInstances = (
  db: Database,
  accountId: Uuid,
  ...conditions: SQL[]
) =>
  db
    .select({ instanceId: instanceMembers.instanceId })
    .from(instanceMembers)
    .innerJoin(instances, eq(instanceMembers.instanceId, instances.id))
    .where(
      and(
        eq(instanceMembers.accountId, accountId),
        isNotNull(instanceMembers.accepted),
        isNotNull(instances.localId),
        ...conditions,
      ),
    );

/**
 * Restricts rows to those of the local instances whose private records the
 * viewer may read: every local instance for an administrator, and those the
 * viewer is an accepted member of otherwise, as the `admin` and
 * `localInstanceMember` scopes decide for one instance.  Filtering rows by it
 * before paging keeps a connection from telling of rows the viewer may not
 * read.
 * @param viewer The viewer and the database.
 * @param instanceId The column of the instance a row belongs to.
 * @returns The condition on the column.
 */
export function viewableInstance(viewer: Viewer, instanceId: PgColumn): SQL {
  const { account } = viewer;
  if (account == null) return sql`false`;
  return account.admin
    ? inArray(
        instanceId,
        viewer.db
          .select({ id: instances.id })
          .from(instances)
          .where(isNotNull(instances.localId)),
      )
    : inArray(instanceId, memberInstances(viewer.db, account.id));
}

// The predicates below are nested into queries on the same tables, so each
// subquery reads an alias of its own to never capture the outer row.  An
// alias renders as its name alone, so a FROM clause names its table as well.
const authors = alias(actors, "readable_authors");
const remoteActivities = alias(activities, "readable_remote_activities");
const remoteObjects = alias(objects, "readable_remote_objects");
const entries = alias(addressing, "readable_addressing");
const targets = alias(resources, "readable_targets");
const deliveries = alias(activityDeliveries, "readable_deliveries");

const remoteActivity = (id: SQLWrapper): SQL => sql`exists (
  select 1 from ${activities} ${remoteActivities}
  join ${actors} ${authors} on ${authors.id} = ${remoteActivities.actorId}
  where ${remoteActivities.id} = ${id} and ${authors.localId} is null
)`;

const remoteObject = (id: SQLWrapper): SQL => sql`exists (
  select 1 from ${objects} ${remoteObjects}
  join ${actors} ${authors} on ${authors.id} = ${remoteObjects.actorId}
  where ${remoteObjects.id} = ${id} and ${authors.localId} is null
)`;

const addressedPublicly = (id: SQLWrapper): SQL => sql`exists (
  select 1 from ${addressing} ${entries}
  join ${resources} ${targets} on ${targets.id} = ${entries.targetId}
  where ${entries.sourceId} = ${id} and ${inArray(targets.iri, PUBLIC_IRIS)}
)`;

const received = (viewer: Viewer, id: SQLWrapper): SQL => sql`exists (
  select 1 from ${activityDeliveries} ${deliveries}
  where ${deliveries.activityId} = ${id}
    and ${deliveries.direction} = 'inbound'
    and ${viewableInstance(viewer, deliveries.instanceId)}
)`;

// True for anything but an activity of a remote actor.
const readableActivity = (viewer: Viewer, id: SQLWrapper): SQL =>
  sql`(not ${remoteActivity(id)} or ${addressedPublicly(id)} or ${received(viewer, id)})`;

// True for anything but an object of a remote actor.  Only the activity that
// carried the stored version opens it, since a later one may carry another;
// one whose activity is gone stays closed.
const readableObject = (viewer: Viewer, id: SQLWrapper): SQL =>
  sql`(not ${remoteObject(id)} or ${addressedPublicly(id)} or exists (
    select 1 from ${objects} ${remoteObjects}
    where ${remoteObjects.id} = ${id}
      and ${remoteObjects.activityId} is not null
      and ${readableActivity(viewer, remoteObjects.activityId)}
  ))`;

/**
 * Restricts resources to those the viewer may read.  Received content is an
 * inbox's, which ActivityPub filters by the requester's permission (5.2) and
 * opens without authentication only when addressed to the public (5.6):
 *
 *  -  An administrator reads everything.
 *  -  An activity of a remote actor is readable when it is addressed to the
 *     public, or when one of the local instances the viewer is a member of
 *     received it, i.e. an inbound delivery to it is linked to the activity.
 *  -  An object of a remote actor is readable when it is addressed to the
 *     public, or when the viewer may read the activity it was received in.
 *  -  Everything else, including the activities and objects of local actors
 *     whatever their addressing, is readable.
 *
 * Filtering rows by it before paging keeps a connection from telling of rows
 * the viewer may not read.
 * @param viewer The viewer and the database.
 * @param id The resource ID in an outer query.
 * @returns The condition on the ID.
 */
export function readableResource(viewer: Viewer, id: SQLWrapper): SQL {
  if (viewer.account?.admin === true) return sql`true`;
  return sql`(${readableActivity(viewer, id)} and ${readableObject(viewer, id)})`;
}

/**
 * Finds the resources among the given IDs that the viewer may not read, as
 * {@link readableResource} decides.  IDs of anything but a resource are never
 * among them.
 * @returns The IDs the viewer may not read.
 */
export async function unreadableResources(
  viewer: Viewer,
  ids: readonly Uuid[],
): Promise<ReadonlySet<Uuid>> {
  if (ids.length === 0 || viewer.account?.admin === true) return new Set();
  const rows = await viewer.db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        inArray(resources.id, [...ids]),
        not(readableResource(viewer, resources.id)),
      ),
    );
  return new Set(rows.map(({ id }) => id));
}

/**
 * Determines whether the viewer may read the resource.
 * @returns Whether {@link readableResource} holds for it.
 */
export const isReadableResource = async (
  viewer: Viewer,
  id: Uuid,
): Promise<boolean> => !(await unreadableResources(viewer, [id])).has(id);

const nodeIdOf = (node: unknown): Uuid | null =>
  node != null &&
  typeof node === "object" &&
  "id" in node &&
  validateUuid(node.id)
    ? node.id
    : null;

/**
 * Replaces the Relay nodes the viewer may not read by null, as if they did
 * not exist.  Activities, objects, and resources share their IDs, so a node's
 * ID alone tells whether it is one the viewer may not read.
 * @returns The nodes, in the same order.
 */
export async function hideUnreadableNodes(
  viewer: Viewer,
  nodes: readonly unknown[],
): Promise<unknown[]> {
  const hidden = await unreadableResources(
    viewer,
    nodes.map(nodeIdOf).filter((id) => id != null),
  );
  return nodes.map((node) => {
    const id = nodeIdOf(node);
    return id != null && hidden.has(id) ? null : node;
  });
}
