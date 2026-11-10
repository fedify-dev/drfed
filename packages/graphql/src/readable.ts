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
  collections,
  instanceMembers,
  instances,
  objects,
  resourceRevisions,
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
const carriers = alias(activities, "readable_carriers");
const entries = alias(addressing, "readable_addressing");
const targets = alias(resources, "readable_targets");
const deliveries = alias(activityDeliveries, "readable_deliveries");
const visibleOwners = alias(actors, "visible_owners");
const ownedObjects = alias(objects, "visible_objects");
const ownedActivities = alias(activities, "visible_activities");
const ownedCollections = alias(collections, "visible_collections");
const typedActors = alias(actors, "history_actors");
const typedObjects = alias(objects, "history_objects");
const typedActivities = alias(activities, "history_activities");
const typedCollections = alias(collections, "history_collections");
const capturedRevisions = alias(resourceRevisions, "history_revisions");

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

// Whether an instance the viewer may read received the activity, by one of
// its deliveries the mark says carried what is opened.
const received = (viewer: Viewer, id: SQLWrapper, mark: PgColumn): SQL =>
  sql`exists (
    select 1 from ${activityDeliveries} ${deliveries}
    where ${deliveries.activityId} = ${id}
      and ${deliveries.direction} = 'inbound'
      and ${mark}
      and ${viewableInstance(viewer, deliveries.instanceId)}
  )`;

// True for anything but an activity of a remote actor.
const readableActivity = (viewer: Viewer, id: SQLWrapper): SQL =>
  sql`(not ${remoteActivity(id)} or ${addressedPublicly(id)} or ${received(viewer, id, deliveries.carriedSnapshot)})`;

// True for anything but an object of a remote actor.  Only the activity that
// carried the stored version opens it, since a later one may carry another;
// one whose activity row is gone stays closed, since a missing row proves
// nothing of who may read it.  That activity being public opens only an
// object embedded in it, since of one fetched apart it made public no more
// than the IRI.  Receiving that activity opens it only by a delivery that
// carried the object as stored too, since one fetched apart from the activity
// may differ from fetch to fetch.
const readableObject = (viewer: Viewer, id: SQLWrapper): SQL =>
  sql`(not ${remoteObject(id)} or ${addressedPublicly(id)} or exists (
    select 1 from ${objects} ${remoteObjects}
    join ${activities} ${carriers} on ${carriers.id} = ${remoteObjects.activityId}
    where ${remoteObjects.id} = ${id}
      and (
        (not ${remoteObjects.fetched} and ${addressedPublicly(carriers.id)})
        or ${received(viewer, carriers.id, deliveries.carriedObjectSnapshot)}
      )
  ))`;

/**
 * Restricts resources to those the viewer may read.  Received content is an
 * inbox's, which ActivityPub filters by the requester's permission (5.2) and
 * opens without authentication only when addressed to the public (5.6):
 *
 *  -  An administrator reads everything.
 *  -  An activity of a remote actor is readable when it is addressed to the
 *     public, or when one of the local instances the viewer is a member of
 *     received it, i.e. an inbound delivery to it is linked to the activity
 *     and carried it as stored.  A delivery of the same IRI with other
 *     contents stays linked but opens nothing.
 *  -  An object of a remote actor is readable when it is addressed to the
 *     public, when the activity that carried it embedded in it is, or when
 *     one of the local instances the viewer is a member of received that
 *     activity and the object as stored with it.  An object fetched apart
 *     from the activity is opened neither by the activity being public nor
 *     by a delivery but one that fetched it as stored.
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
 * Excludes deleted actors and objects, including resources authored or
 * owned by deleted actors.  Revisions do not use it: a deletion appends a
 * whiteout, and the history before it stays readable, as
 * {@link readableHistory} tells.
 * @param id The resource ID in an outer query.
 * @returns The condition on the ID.
 */
export function visibleResource(id: SQLWrapper): SQL {
  return sql`not exists (
    select 1 from ${actors} ${visibleOwners}
    where ${visibleOwners.id} = ${id} and ${visibleOwners.deleted} is not null
  ) and not exists (
    select 1 from ${objects} ${ownedObjects}
    join ${actors} ${visibleOwners} on ${visibleOwners.id} = ${ownedObjects.actorId}
    where ${ownedObjects.id} = ${id}
      and (${ownedObjects.deleted} is not null or ${visibleOwners.deleted} is not null)
  ) and not exists (
    select 1 from ${activities} ${ownedActivities}
    join ${actors} ${visibleOwners} on ${visibleOwners.id} = ${ownedActivities.actorId}
    where ${ownedActivities.id} = ${id} and ${visibleOwners.deleted} is not null
  ) and not exists (
    select 1 from ${collections} ${ownedCollections}
    join ${actors} ${visibleOwners} on ${visibleOwners.id} = ${ownedCollections.ownerActorId}
    where ${ownedCollections.id} = ${id} and ${visibleOwners.deleted} is not null
  )`;
}

/**
 * Matches a generic resource, one without a legacy typed row, with a
 * revision DrFed did not save itself: received, embedded or fetched.
 *
 * PENDING TEAM DECISION: no evidence opens such a history yet, since the
 * rules of {@link readableResource} are those of typed rows, and no write
 * path creates such resources yet.  Until the team decides what opens them,
 * their revisions are closed, while the resource itself, its IRI and kind,
 * stays readable as before.  This is the one place that rule lives;
 * {@link readableHistory} applies it.
 * @param id The resource ID in an outer query.
 * @returns The condition on the ID.
 */
export function unprovenGenericHistory(id: SQLWrapper): SQL {
  return sql`(not ${legacyTypedRow(id)} and exists (
    select 1 from ${resourceRevisions} ${capturedRevisions}
    where ${capturedRevisions.resourceId} = ${id}
      and ${capturedRevisions.capture} <> 'local'
  ))`;
}

/**
 * Matches a resource with a legacy typed row, whose readability
 * {@link readableResource} decides by that row.  It is the only place
 * {@link unprovenGenericHistory} reads legacy typed tables, so that it goes
 * when they do.
 * @param id The resource ID in an outer query.
 * @returns The condition on the ID.
 */
function legacyTypedRow(id: SQLWrapper): SQL {
  return sql`(exists (
    select 1 from ${actors} ${typedActors} where ${typedActors.id} = ${id}
  ) or exists (
    select 1 from ${objects} ${typedObjects} where ${typedObjects.id} = ${id}
  ) or exists (
    select 1 from ${activities} ${typedActivities} where ${typedActivities.id} = ${id}
  ) or exists (
    select 1 from ${collections} ${typedCollections} where ${typedCollections.id} = ${id}
  ))`;
}

/**
 * Restricts resources to those whose revisions the viewer may read.  Every
 * revision, past ones included, follows the rule of its resource: it must be
 * readable, as {@link readableResource} tells, and its history must not be
 * one {@link unprovenGenericHistory} closes.  Local resources are therefore
 * readable by anyone, with their blind recipients and whether published or
 * not, as `Object.document` is.  Deletion hides no revision: it appends a
 * whiteout, and the history before it, of a deleted resource or of one
 * whose author is deleted, stays readable to whoever may read the resource.
 * Readability is the existing rule, which still reads legacy typed rows;
 * everything else about revisions is read from the revisions themselves.
 * @param viewer The viewer and the database.
 * @param id The resource ID in an outer query.
 * @returns The condition on the ID.
 */
export function readableHistory(viewer: Viewer, id: SQLWrapper): SQL {
  return and(readableResource(viewer, id), not(unprovenGenericHistory(id)))!;
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

const uuidOf = (node: unknown, key: "id" | "resourceId"): Uuid | null =>
  node != null &&
  typeof node === "object" &&
  key in node &&
  validateUuid((node as Record<typeof key, unknown>)[key])
    ? ((node as Record<typeof key, unknown>)[key] as Uuid)
    : null;

/**
 * Tells the resource a Relay node belongs to without being its typed detail,
 * as a revision belongs to its resource.  Such a node is hidden as that
 * resource's history is, by {@link readableHistory}, and nothing of its own,
 * such as a whiteout's deletion time, hides it.
 * @returns The resource ID, or null for any other node.
 */
export const owningResourceOf = (node: unknown): Uuid | null =>
  uuidOf(node, "resourceId");

/**
 * Replaces the Relay nodes the viewer may not read by null, as if they did
 * not exist.  Activities, objects, and resources share their IDs, so a node's
 * ID alone tells whether it is one the viewer may not read; a node that
 * belongs to a resource, such as a revision, is checked against that
 * resource's history instead, as {@link owningResourceOf} tells.
 * @returns The nodes, in the same order.
 */
export async function hideUnreadableNodes(
  viewer: Viewer,
  nodes: readonly unknown[],
): Promise<unknown[]> {
  const owningIds = nodes.map(owningResourceOf);
  const ids = nodes.map((node, index) =>
    owningIds[index] == null ? uuidOf(node, "id") : null,
  );
  const owned = [...new Set(owningIds.filter((id) => id != null))];
  const [hidden, readableOwners] = await Promise.all([
    unreadableResources(
      viewer,
      ids.filter((id) => id != null),
    ),
    owned.length === 0
      ? []
      : viewer.db
          .select({ id: resources.id })
          .from(resources)
          .where(
            and(
              inArray(resources.id, owned),
              readableHistory(viewer, resources.id),
            ),
          ),
  ]);
  const open = new Set(readableOwners.map(({ id }) => id));
  return nodes.map((node, index) => {
    const owner = owningIds[index];
    if (owner != null) return open.has(owner) ? node : null;
    const id = ids[index];
    return id != null && hidden.has(id) ? null : node;
  });
}
