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
    loginTokens: r.many.loginTokens({
      from: r.accounts.id,
      to: r.loginTokens.accountId,
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
    localInstances: r.one.localInstances({
      from: r.instances.localId,
      to: r.localInstances.id,
    }),
  },
  localInstance: {
    instances: r.one.instances({
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
  loginTokens: {
    account: r.one.accounts({
      from: r.loginTokens.accountId,
      to: r.accounts.id,
      optional: false,
    }),
  },
  actors: {
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
