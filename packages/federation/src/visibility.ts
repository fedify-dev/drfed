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
import { PUBLIC_RESOURCE_ID } from "@drfed/models/resource";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

const {
  activities,
  actorCollectionReferences,
  actors,
  collectionItems,
  instances,
  objects,
  resourceHeads,
  resourceRevisions,
  resources,
  revisionRelations,
} = schema;

/**
 * Shared Public predicate for object, activity, outbox page and counter.
 * @returns An EXISTS predicate matching explicit Public addressing.
 */
export function publicAddressing(sourceId: SQLWrapper): SQL {
  return sql`exists (select 1 from ${schema.addressing} where ${schema.addressing.sourceId} = ${sourceId} and ${schema.addressing.targetId} = ${PUBLIC_RESOURCE_ID} and ${schema.addressing.property} in ('to', 'cc'))`;
}

// The predicates below are nested into queries on the same tables, so each
// subquery reads an alias of its own to never capture the outer row.  An
// alias renders as its name alone, so a FROM clause names its table as well.
const typedActivities = alias(activities, "served_typed_activities");
const typedObjects = alias(objects, "served_typed_objects");
const heads = alias(resourceHeads, "served_heads");
const revisions = alias(resourceRevisions, "served_revisions");
const relations = alias(revisionRelations, "served_relations");
const servedResources = alias(resources, "served_resources");
const items = alias(collectionItems, "served_items");
const references = alias(actorCollectionReferences, "served_references");
const owners = alias(actors, "served_owners");
const ownerInstances = alias(instances, "served_owner_instances");

const typedActivity = (id: SQLWrapper): SQL =>
  sql`exists (select 1 from ${activities} ${typedActivities} where ${typedActivities.id} = ${id})`;

const typedObject = (id: SQLWrapper): SQL =>
  sql`exists (select 1 from ${objects} ${typedObjects} where ${typedObjects.id} = ${id})`;

// A legacy activity is served as `Create` while its object is not deleted.
const servedTypedActivity = (id: SQLWrapper): SQL => sql`exists (
  select 1 from ${activities} ${typedActivities}
  where ${typedActivities.id} = ${id}
    and ${typedActivities.type} = 'Create'
    and exists (select 1 from ${objects} ${typedObjects} where ${typedObjects.id} = ${typedActivities.objectId} and ${typedObjects.deleted} is null)
)`;

const resourceKind = (id: SQLWrapper, kind: string): SQL =>
  sql`exists (select 1 from ${resources} ${servedResources} where ${servedResources.id} = ${id} and ${servedResources.kind} = ${kind})`;

const headKind = (id: SQLWrapper, kind: string): SQL => sql`exists (
  select 1 from ${resourceHeads} ${heads}
  join ${resourceRevisions} ${revisions} on ${revisions.id} = ${heads.revisionId}
  where ${heads.resourceId} = ${id} and ${revisions.kind} = ${kind}
)`;

/**
 * Matches the activities that are served over ActivityPub, wherever they
 * are read: Public activity resources that are either a legacy `Create`
 * whose object has not been deleted, or a saved activity whose current
 * revision is a snapshot.  The activity dispatchers, the outbox pages and
 * the outbox counter share it, so that none of them can disagree with the
 * others about what is served.  A saved activity is served only when what
 * its document embeds and refers to allows it as well, which only the
 * document can tell; see *serving/resource.ts*.
 * @param id The activity's resource ID in an outer query.
 * @returns The condition on the ID.
 */
export function servedActivity(id: SQLWrapper): SQL {
  return sql`(${resourceKind(id, "activity")} and ${publicAddressing(id)} and (${servedTypedActivity(id)} or (not ${typedActivity(id)} and ${headKind(id, "snapshot")})))`;
}

/**
 * Matches the local objects that have been deleted: those whose legacy row
 * of a local actor is, and those whose current revision is a whiteout of a
 * locally captured history.
 * @param id The object's resource ID in an outer query.
 * @returns The condition on the ID.
 */
export function deletedLocalObject(id: SQLWrapper): SQL {
  return sql`(${resourceKind(id, "object")} and (
    exists (
      select 1 from ${objects} ${typedObjects}
      join ${actors} ${owners} on ${owners.id} = ${typedObjects.actorId}
      where ${typedObjects.id} = ${id}
        and ${typedObjects.deleted} is not null
        and ${owners.localId} is not null
    )
    or exists (
      select 1 from ${resourceHeads} ${heads}
      join ${resourceRevisions} ${revisions} on ${revisions.id} = ${heads.revisionId}
      where ${heads.resourceId} = ${id}
        and ${revisions.kind} = 'whiteout'
        and ${revisions.capture} = 'local'
    )
  ))`;
}

/**
 * Matches the outbox items that pages list: those with a position, since a
 * page cursor never reaches an item without one.  The activity dispatchers
 * and the outbox pages and counter share it.
 * @param position The item's position in an outer query.
 * @returns The condition on the position.
 */
export function listedItem(position: SQLWrapper): SQL {
  return sql`${position} is not null`;
}

/**
 * Matches the resources listed, as {@link listedItem} tells, in the outbox of
 * a live local actor of the instance the request names.  Another instance's
 * authority cannot reach a resource by guessing its identifier.
 * @param id The resource ID in an outer query.
 * @param host The canonical authority of the request.
 * @returns The condition on the ID.
 */
export function inLocalOutbox(id: SQLWrapper, host: string): SQL {
  return sql`exists (
    select 1 from ${collectionItems} ${items}
    join ${actorCollectionReferences} ${references} on ${references.collectionId} = ${items.collectionId} and ${references.role} = 'outbox'
    join ${actors} ${owners} on ${owners.id} = ${references.actorId}
    join ${instances} ${ownerInstances} on ${ownerInstances.id} = ${owners.instanceId}
    where ${items.itemId} = ${id}
      and ${listedItem(items.position)}
      and ${owners.localId} is not null
      and ${owners.deleted} is null
      and ${ownerInstances.host} = ${host}
  )`;
}

/**
 * Matches the saved objects, without a legacy row, that are served at the
 * actor's object route: Public, and attributed to the actor by their last
 * snapshot, which for a deleted object is the version before its whiteout.
 * @param id The object's resource ID in an outer query.
 * @param actorIri The IRI of the live local actor the route names.
 * @returns The condition on the ID.
 */
export function servedObjectRevision(id: SQLWrapper, actorIri: string): SQL {
  return sql`(not ${typedObject(id)} and ${publicAddressing(id)} and exists (
    select 1 from ${revisionRelations} ${relations}
    where ${relations.revisionId} = (
        select ${revisions.id} from ${resourceRevisions} ${revisions}
        where ${revisions.resourceId} = ${id} and ${revisions.kind} = 'snapshot'
        order by ${revisions.sequence} desc limit 1
      )
      and ${relations.property} = 'attributedTo'
      and ${relations.targetIri} = ${actorIri}
  ))`;
}
