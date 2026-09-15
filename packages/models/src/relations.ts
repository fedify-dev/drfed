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

import { defineRelations } from "drizzle-orm";

import * as schema from "./schema.ts";

export const relations = defineRelations(schema, (r) => ({
  accounts: {
    instances: r.many.instances({
      from: r.accounts.id.through(r.instanceMembers.accountId),
      to: r.instances.id.through(r.instanceMembers.instanceId),
      // Drizzle ORM currently does not support many-to-many relationships with
      // additional filters on the junction table.  So we need to specify
      // filter `accepted IS NOT NULL` everywhere we query for instances of
      // an account (sigh).  See also the below issue:
      // https://github.com/drizzle-team/drizzle-orm/issues/5343
    }),
    instanceMembers: r.many.instanceMembers({
      from: r.accounts.id,
      to: r.instanceMembers.accountId,
      where: {
        accepted: { isNotNull: true },
      },
    }),
    sessions: r.many.sessions({
      from: r.accounts.id,
      to: r.sessions.accountId,
    }),
    loginChallenges: r.many.loginChallenges({
      from: r.accounts.id,
      to: r.loginChallenges.accountId,
    }),
  },
  instanceMembers: {
    account: r.one.accounts({
      from: r.instanceMembers.accountId,
      to: r.accounts.id,
    }),
    instance: r.one.instances({
      from: r.instanceMembers.instanceId,
      to: r.instances.id,
    }),
  },
  instances: {
    members: r.many.accounts({
      from: r.instances.id.through(r.instanceMembers.instanceId),
      to: r.accounts.id.through(r.instanceMembers.accountId),
      // Drizzle ORM currently does not support many-to-many relationships with
      // additional filters on the junction table.  So we need to specify
      // filter `accepted IS NOT NULL` everywhere we query for members of
      // an instance (sigh).  See also the below issue:
      // https://github.com/drizzle-team/drizzle-orm/issues/5343
    }),
    instanceMembers: r.many.instanceMembers({
      from: r.instances.id,
      to: r.instanceMembers.instanceId,
      where: {
        accepted: { isNotNull: true },
      },
    }),
    actors: r.many.actors({ from: r.instances.id, to: r.actors.instanceId }),
    localInstance: r.one.localInstances({
      from: r.instances.localId,
      to: r.localInstances.id,
    }),
  },
  localInstances: {
    instance: r.one.instances({
      from: r.localInstances.id,
      to: r.instances.localId,
    }),
  },
  sessions: {
    account: r.one.accounts({
      from: r.sessions.accountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  loginChallenges: {
    account: r.one.accounts({
      from: r.loginChallenges.accountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  resources: {
    actor: r.one.actors({
      from: r.resources.id,
      to: r.actors.id,
      optional: true,
    }),
    object: r.one.objects({
      from: r.resources.id,
      to: r.objects.id,
      optional: true,
    }),
    activity: r.one.activities({
      from: r.resources.id,
      to: r.activities.id,
      optional: true,
    }),
    collection: r.one.collections({
      from: r.resources.id,
      to: r.collections.id,
      optional: true,
    }),
    addressedBy: r.many.addressing({
      from: r.resources.id,
      to: r.addressing.targetId,
    }),
  },
  addressing: {
    source: r.one.resources({
      from: r.addressing.sourceId,
      to: r.resources.id,
      optional: false,
    }),
    targetResource: r.one.resources({
      from: r.addressing.targetId,
      to: r.resources.id,
      optional: false,
    }),
  },
  actorCollectionReferences: {
    actor: r.one.actors({
      from: r.actorCollectionReferences.actorId,
      to: r.actors.id,
      optional: false,
    }),
    collection: r.one.collections({
      from: r.actorCollectionReferences.collectionId,
      to: r.collections.id,
      optional: false,
    }),
  },
  collections: {
    resource: r.one.resources({
      from: r.collections.id,
      to: r.resources.id,
      optional: false,
    }),
    ownerActor: r.one.actors({
      from: r.collections.ownerActorId,
      to: r.actors.id,
    }),
    items: r.many.collectionItems({
      from: r.collections.id,
      to: r.collectionItems.collectionId,
    }),
  },
  collectionItems: {
    collection: r.one.collections({
      from: r.collectionItems.collectionId,
      to: r.collections.id,
      optional: false,
    }),
    item: r.one.resources({
      from: r.collectionItems.itemId,
      to: r.resources.id,
      optional: false,
    }),
  },
  activities: {
    resource: r.one.resources({
      from: r.activities.id,
      to: r.resources.id,
      optional: false,
    }),
    actor: r.one.actors({
      from: r.activities.actorId,
      to: r.actors.id,
      optional: false,
    }),
    object: r.one.resources({
      from: r.activities.objectId,
      to: r.resources.id,
    }),
    addressing: r.many.addressing({
      from: r.activities.id,
      to: r.addressing.sourceId,
    }),
  },
  objects: {
    resource: r.one.resources({
      from: r.objects.id,
      to: r.resources.id,
      optional: false,
    }),
    addressing: r.many.addressing({
      from: r.objects.id,
      to: r.addressing.sourceId,
    }),
    createActivity: r.one.activities({
      from: r.objects.id,
      to: r.activities.objectId,
      optional: true,
      where: { type: "Create" },
    }),
    actor: r.one.actors({
      from: r.objects.actorId,
      to: r.actors.id,
      optional: false,
    }),
  },
  actors: {
    collectionReferences: r.many.actorCollectionReferences({
      from: r.actors.id,
      to: r.actorCollectionReferences.actorId,
    }),
    resource: r.one.resources({
      from: r.actors.id,
      to: r.resources.id,
      optional: false,
    }),
    collections: r.many.collections({
      from: r.actors.id,
      to: r.collections.ownerActorId,
    }),
    activities: r.many.activities({
      from: r.actors.id,
      to: r.activities.actorId,
    }),
    objects: r.many.objects({ from: r.actors.id, to: r.objects.actorId }),
    instance: r.one.instances({
      from: r.actors.instanceId,
      to: r.instances.id,
      optional: false,
    }),
    localActor: r.one.localActors({
      from: r.actors.localId,
      to: r.localActors.id,
    }),
  },
  localActors: {
    actor: r.one.actors({ from: r.localActors.id, to: r.actors.localId }),
  },
}));

export default relations;
