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

import { type relations, schema } from "@drfed/models";
import { actorTypeEnum } from "@drfed/models/schema";
import type { ExpandContext } from "@fedify/uri-template";
import type { BuildQueryResult, DBQueryConfig } from "drizzle-orm";
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

type DrizzleRelations = typeof relations;
type ActorTableConfig = DrizzleRelations["actors"];
type ActorSelect = DBQueryConfig<"one", DrizzleRelations, ActorTableConfig>;

const ACTOR_REF_SELECT = {
  columns: { id: true, username: true },
  with: {
    instance: {
      columns: { id: true },
      with: { localInstances: true, remoteInstances: true },
    },
    localActor: true,
    remoteActor: true,
  },
} as const satisfies ActorSelect;

type SelectedActor = BuildQueryResult<
  DrizzleRelations,
  ActorTableConfig,
  typeof ACTOR_REF_SELECT
>;

interface LocalTemplateArgs extends ExpandContext {
  id: string;
  host: string;
  username: string;
  avatar: string | null;
  header: string | null;
}

const getLocalInfo = (actor: SelectedActor, root: string): LocalTemplateArgs =>
  actor?.localActor == null || actor.instance?.localInstances == null
    ? throwNonLocal(actor.id, "actor")
    : {
        id: actor.id,
        host: `${actor.instance.localInstances.slug}.${root}`,
        username: actor.username,
        avatar: actor.localActor.avatar,
        header: actor.localActor.header,
      };

function throwNonLocal(id: string, kind: "actor" | "instance"): never {
  throw new Error(`This ${kind} is not local: ${id}`);
}

const ActorRef = builder.drizzleNode("actors", {
  name: "Actor",
  description: "Represents an `Actor` in the DrFed platform.",
  id: {
    column: ({ id }) => id,
    description: "The unique identifier of the `Actor`.",
  },
  select: ACTOR_REF_SELECT,
  fields: (t) => ({
    iri: t.field({
      type: "String",
      resolve: (parent, _, ctx) =>
        parent.remoteActor?.iriUrl ??
        templates.iri.expand(getLocalInfo(parent, ctx.root)),
      description: "The Internationalized Resource Identifier of the `Actor`",
    }),
    handle: t.field({
      type: "String",
      description: "The handle of the `Actor`.",
      resolve: (parent, _, ctx) =>
        templates.handle.expand(
          parent.instance?.remoteInstances
            ? {
                username: parent.username,
                host: parent.instance.remoteInstances.host,
              }
            : getLocalInfo(parent, ctx.root),
        ),
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
    inboxUrl: t.field({
      type: "String",
      description: "The inbox URL of the `Actor`.",
      resolve: (parent, _, ctx) =>
        parent.remoteActor?.inboxUrl ??
        templates.inbox.expand(getLocalInfo(parent, ctx.root)),
    }),
    outboxUrl: t.field({
      type: "String",
      description: "The outbox URL of the `Actor`.",
      resolve: (parent, _, ctx) =>
        parent.remoteActor?.outboxUrl ??
        templates.outbox.expand(getLocalInfo(parent, ctx.root)),
    }),
    avatarUrl: t.field({
      type: "String",
      description: "The avatar URL of the `Actor`.",
      nullable: true,
      resolve: (parent, _, ctx) =>
        parent.remoteActor
          ? parent.remoteActor.avatarUrl
          : templates.avatar.expand(getLocalInfo(parent, ctx.root)),
    }),
    followersUrl: t.field({
      type: "String",
      description: "The followers URL of the `Actor`.",
      nullable: true,
      resolve: (parent, _, ctx) =>
        parent.remoteActor != null
          ? parent.remoteActor.followersUrl
          : templates.followers.expand(getLocalInfo(parent, ctx.root)),
    }),
    followeesUrl: t.field({
      type: "String",
      description: "The followees URL of the `Actor`.",
      nullable: true,
      resolve: (parent, _, ctx) =>
        parent.remoteActor != null
          ? parent.remoteActor.followeesUrl
          : templates.followees.expand(getLocalInfo(parent, ctx.root)),
    }),
    headerUrl: t.field({
      type: "String",
      description: "The header URL of the `Actor`.",
      nullable: true,
      resolve: (parent, _, ctx) =>
        parent.remoteActor != null
          ? parent.remoteActor.headerUrl
          : templates.header.expand(getLocalInfo(parent, ctx.root)),
    }),
    profileUrl: t.field({
      type: "String",
      description: "The profile URL of the `Actor`.",
      nullable: true,
      resolve: (parent, _, ctx) =>
        parent.remoteActor != null
          ? parent.remoteActor.profileUrl
          : templates.profile.expand(getLocalInfo(parent, ctx.root)),
    }),
    featuredUrl: t.field({
      type: "String",
      description: "The featured URL of the `Actor`.",
      nullable: true,
      resolve: (parent, _, ctx) =>
        parent.remoteActor != null
          ? parent.remoteActor.featuredUrl
          : templates.featured.expand(getLocalInfo(parent, ctx.root)),
    }),
  }),
});

export const Actor: DrFedObjectRef = ActorRef;

const CreateActorsRef = builder.drizzleNode("localActors", {
  name: "CreateActors",
  description: "Represents an `Actor` in the DrFed platform.",
  id: {
    column: ({ id }) => id,
    description: "The unique identifier of the `Actor`.",
  },
  select: {
    columns: { id: true },
    with: { actor: { columns: { username: true } } },
  },
  fields: (t) => ({
    username: t.field({
      type: "String",
      description: "username",
      resolve: ({ actor }) => actor!.username,
    }),
  }),
});

interface CreateActorsSuccess {
  readonly actors: readonly (typeof CreateActorsRef.$inferType)[];
}

const CreateActorsSuccessRef = builder.objectRef<CreateActorsSuccess>(
  "CreateActorsSuccess",
);

CreateActorsSuccessRef.implement({
  fields: (t) => ({
    actors: t.field({
      type: [CreateActorsRef],
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
  maxActors: number;
  slug: string;
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
      const { account, root } = ctx;

      let instance: SelectedInstance | undefined;
      let tooManyActors = false;
      try {
        return await ctx.db.transaction(async (tx) => {
          // Find the instance that the account is included
          [instance] = await tx
            .select({
              maxActors: schema.localInstances.maxActors,
              slug: schema.localInstances.slug,
            })
            .from(schema.instanceMembers)
            .innerJoin(
              schema.instances,
              eq(schema.instanceMembers.instanceId, schema.instances.id),
            )
            .innerJoin(
              schema.localInstances,
              eq(schema.instances.id, schema.localInstances.id),
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
          const { slug, maxActors } = instance;
          const host = `${slug}.${root}`;
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
          const createdActors = await tx
            .insert(schema.actors)
            .values(
              Array.from({ length: size }).map(() => genActor(instanceId)),
            )
            .returning();
          const actorCounts = await tx.$count(
            schema.actors,
            eq(schema.actors.instanceId, instanceId),
          );
          if (actorCounts > maxActors) {
            tooManyActors = true;
            tx.rollback();
          }
          const localActors = await tx
            .insert(schema.localActors)
            .values(createdActors)
            .returning();
          // oxlint-disable-next-line eslint/id-length
          const actors = localActors.map((local, i) => ({
            actor: createdActors[i]!,
            ...local,
          }));
          return { actors };
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
              instance.slug
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

function genActor(instanceId: string): PgInsertValue<typeof schema.actors> {
  const id = uuid();
  return {
    id,
    // FIXME: Generate handle using Faker.js or something
    username: id,
    location: "Local",
    instanceId,
    type: "Person",
  };
}
