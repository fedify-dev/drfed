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

// oxlint-disable max-lines-per-function eslint/max-lines

import { schema } from "@drfed/models";
import { actorTypeEnum } from "@drfed/models/schema";
import type { PgInsertValue } from "drizzle-orm/pg-core";
import { and, eq, gt, isNotNull } from "drizzle-orm/sql/expressions";
import { v7 as uuid } from "uuid";

import builder, { type DrFedObjectRef } from "./builder.ts";
// oxlint-disable-next-line import/no-cycle
import { Instance } from "./instance.ts";
import templates from "./uri-templates.ts";

export const ActorType = builder.enumType("ActorType", {
  values: actorTypeEnum.enumValues,
});

export const ACTOR_TYPES = actorTypeEnum.enumValues.join(" | ");

const ActorRef = builder.drizzleNode("actors", {
  name: "Actor",
  description: "Represents an `Actor` in the DrFed platform.",
  id: {
    column: ({ id }) => id,
    description: "The unique identifier of the `Actor`.",
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The UUID of the `Actor`.",
    }),
    iri: t.exposeString("iri", {
      description: "The Internationalized Resource Identifier of the `Actor`",
    }),
    handle: t.field({
      type: "String",
      description: "The handle of the `Actor`.",
      select: {
        columns: { username: true },
        with: { instance: { columns: { host: true } } },
      },
      resolve: ({ instance, username }) =>
        templates.handle.expand({ username, host: instance.host }),
    }),
    type: t.expose("type", {
      type: ActorType,
      description: `The type of the \`Actor\`: ${ACTOR_TYPES}`,
    }),
    username: t.exposeString("username", {
      description: "The username of the `Actor`.",
    }),
    instance: t.relation("instance", {
      description: "The `Instance` that the `Actor` belongs to.",
    }),
    local: t.relation("localActor", {
      nullable: true,
      description: "The local details of the `Actor`, or null if it is remote.",
    }),
    inboxUrl: t.exposeString("inboxUrl", {
      description: "The inbox URL of the `Actor`.",
    }),
    outboxUrl: t.exposeString("outboxUrl", {
      description: "The outbox URL of the `Actor`.",
    }),
    avatarUrl: t.exposeString("avatarUrl", {
      description: "The avatar URL of the `Actor`.",
      nullable: true,
    }),
    followersUrl: t.exposeString("followersUrl", {
      description: "The followers URL of the `Actor`.",
      nullable: true,
    }),
    followeesUrl: t.exposeString("followeesUrl", {
      description: "The followees URL of the `Actor`.",
      nullable: true,
    }),
    headerUrl: t.exposeString("headerUrl", {
      description: "The header URL of the `Actor`.",
      nullable: true,
    }),
    profileUrl: t.exposeString("profileUrl", {
      description: "The profile URL of the `Actor`.",
      nullable: true,
    }),
    featuredUrl: t.exposeString("featuredUrl", {
      description: "The featured URL of the `Actor`.",
      nullable: true,
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "The creation date/time of the `Actor`.",
    }),
  }),
});

export const Actor: DrFedObjectRef = ActorRef;

const LocalActorRef = builder.drizzleNode("localActors", {
  name: "LocalActor",
  description: "Represents the local details of an `Actor`.",
  id: {
    column: ({ id }) => id,
    description: "The unique identifier of the local actor details.",
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The UUID of the local actor details.",
    }),
    avatar: t.exposeString("avatar", {
      nullable: true,
      description: "The profile image of the actor.",
    }),
    header: t.exposeString("header", {
      nullable: true,
      description: "The profile banner image of the actor.",
    }),
  }),
});

export const LocalActor: DrFedObjectRef = LocalActorRef;

interface CreateActorsSuccess {
  readonly actors: readonly (typeof ActorRef.$inferType)[];
}

const CreateActorsSuccessRef = builder.objectRef<CreateActorsSuccess>(
  "CreateActorsSuccess",
);

CreateActorsSuccessRef.implement({
  fields: (t) => ({
    actors: t.field({
      type: [ActorRef],
      resolve: ({ actors }) => actors,
    }),
  }),
});

const INVALID_SIZE = "InvalidSize" as const;
const INSTANCE_NOT_FOUND = "InstanceNotFound" as const;
const TOO_MANY_ACTORS = "TooManyActors" as const;
const CreateActorsErrors = [
  INVALID_SIZE,
  INSTANCE_NOT_FOUND,
  TOO_MANY_ACTORS,
] as const;

const CreateActorsErrorType = builder.enumType("CreateActorsErrorType", {
  values: CreateActorsErrors,
});

interface CreateActorsError {
  readonly type: typeof CreateActorsErrorType.$inferType;
  readonly message: string;
}

const CreateActorsErrorRef =
  builder.objectRef<CreateActorsError>("CreateActorsError");

CreateActorsErrorRef.implement({
  description: "Represents an error that occurred while creating an `Actor`.",
  fields: (t) => ({
    type: t.expose("type", {
      type: CreateActorsErrorType,
      description:
        "The type of the error.  Use this for programmatic error handling.",
    }),
    message: t.exposeString("message", {
      description:
        "A human-readable message describing the error.  " +
        "Don't use this for programmatic error handling, " +
        "use the `type` field instead.",
    }),
  }),
});

const CreateActorsResult = builder.unionType("CreateActorsResult", {
  types: [CreateActorsSuccessRef, CreateActorsErrorRef],
  resolveType(value) {
    if ("message" in value) return CreateActorsErrorRef;
    return CreateActorsSuccessRef;
  },
});

interface SelectedInstance {
  host: string;
  maxActors: number;
}

builder.mutationFields((t) => ({
  genActors: t.field({
    type: CreateActorsResult,
    description: "Create actors.",
    authScopes: { authenticated: true },
    args: {
      instance: t.arg.globalID({
        for: Instance,
        required: true,
        description: "The ID of the target instance",
      }),
      size: t.arg({
        type: "Int",
        required: true,
        description: "How many actors to generate",
      }),
    },
    async resolve(_query, { instance: { id: instanceId }, size }, ctx) {
      if (size < 1) {
        return {
          type: INVALID_SIZE,
          message: `${size} is too small. At least 1 or more.`,
        };
      }
      if (ctx.account == null) {
        // Note that the following error is not expected to be thrown,
        // because the `authScopes` option above should prevent this resolver
        throw new Error("You must be authenticated to create actors.");
      }
      const { account } = ctx;

      let instance: SelectedInstance | undefined;
      let tooManyActors = false;
      try {
        return await ctx.db.transaction(async (tx) => {
          // Find the instance that the account is included
          [instance] = await tx
            .select({
              host: schema.instances.host,
              maxActors: schema.localInstances.maxActors,
            })
            .from(schema.instanceMembers)
            .innerJoin(
              schema.instances,
              eq(schema.instanceMembers.instanceId, schema.instances.id),
            )
            .innerJoin(
              schema.localInstances,
              eq(schema.instances.localId, schema.localInstances.id),
            )
            .where(
              and(
                eq(schema.instanceMembers.accountId, account.id),
                gt(schema.localInstances.expires, new Date()),
                eq(schema.instances.id, instanceId),
                isNotNull(schema.instanceMembers.accepted),
              ),
            )
            .limit(1);
          if (instance == null) throw new Error(INSTANCE_NOT_FOUND);
          const { host, maxActors } = instance;
          const currActors = await tx.$count(
            schema.actors,
            eq(schema.actors.instanceId, instanceId),
          );

          if (size + currActors > maxActors) {
            return {
              type: TOO_MANY_ACTORS,
              message: `${size} is too big. The maximum number of actors of ${
                host
              } is ${maxActors} and the current number of actors is ${
                currActors
              }.`,
            };
          }
          // Create actors
          const localActors = await tx
            .insert(schema.localActors)
            .values(Array.from({ length: size }, () => ({ id: uuid() })))
            .returning();
          const createdActors = await tx
            .insert(schema.actors)
            .values(localActors.map(({ id }) => genActor(id, instanceId, host)))
            .returning();
          const actorCounts = await tx.$count(
            schema.actors,
            eq(schema.actors.instanceId, instanceId),
          );
          if (actorCounts > maxActors) {
            tooManyActors = true;
            tx.rollback();
          }
          return { actors: createdActors };
        });
      } catch (e) {
        if (instance == null) {
          if (e instanceof Error && e.message === INSTANCE_NOT_FOUND) {
            return {
              type: INSTANCE_NOT_FOUND,
              message: "Can't find the instance.",
            };
          }
        } else if (tooManyActors) {
          return {
            type: TOO_MANY_ACTORS,
            message: `${
              instance.host
            } instance reached the maximum number of actors (${
              instance.maxActors
            })`,
          };
        }
        throw e;
      }
    },
  }),
}));

function genActor(
  localId: string,
  instanceId: string,
  host: string,
): PgInsertValue<typeof schema.actors> {
  const id = uuid();
  const username = id;
  const templateArgs = { host, id, username };
  return {
    id,
    localId,
    // FIXME: Generate handle using Faker.js or something
    username,
    instanceId,
    type: "Person",
    iri: templates.iri.expand(templateArgs),
    inboxUrl: templates.inbox.expand(templateArgs),
    outboxUrl: templates.outbox.expand(templateArgs),
    followersUrl: templates.followers.expand(templateArgs),
    followeesUrl: templates.followees.expand(templateArgs),
    featuredUrl: templates.featured.expand(templateArgs),
    profileUrl: templates.profile.expand(templateArgs),
  };
}
