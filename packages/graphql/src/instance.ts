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

// oxlint-disable max-lines-per-function
import { schema } from "@drfed/models";
import { instanceMembers } from "@drfed/models/schema";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { DrizzleQueryError } from "drizzle-orm";
import { and, eq, isNotNull } from "drizzle-orm/sql/expressions";
import { v7 as uuid } from "uuid";

// oxlint-disable-next-line import/no-cycle
import { Account } from "./account.ts";
import builder, { type DrFedObjectRef } from "./builder.ts";

const InstanceRef = builder.drizzleNode("instances", {
  name: "Instance",
  description: "Represents an `Instance` in the DrFed platform.",
  id: {
    column(instance) {
      return instance.id;
    },
    description: "The unique identifier of the `Instance`.",
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The UUID of the `Instance`.",
    }),
    slug: t.exposeString("slug"),
    expires: t.expose("expires", {
      type: "DateTime",
      description: "The expiration date/time of the `Instance`.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "The creation date/time of the `Instance`.",
    }),
  }),
});

export const Instance: DrFedObjectRef = InstanceRef;

const instanceMembersConnection = drizzleConnectionHelpers(
  builder,
  "instanceMembers",
  {
    query: {
      orderBy: { created: "desc" },
    },
    select(nestedSelection) {
      return {
        with: {
          account: nestedSelection(),
        },
        where: {
          accepted: { isNotNull: true },
        },
      };
    },
    resolveNode(instanceMember) {
      return instanceMember.account;
    },
  },
);

// oxlint-disable-next-line max-lines-per-function
builder.drizzleObjectField(InstanceRef, "members", (t) =>
  t.connection(
    {
      type: Account,
      description: "The `Account`s that belong to the `Instance`.",
      select(args, ctx, nestedSelection) {
        return {
          with: {
            instanceMembers: instanceMembersConnection.getQuery(
              args,
              ctx,
              nestedSelection,
            ),
          },
        };
      },
      resolve(instance, args, ctx) {
        return {
          ...instanceMembersConnection.resolve(
            instance.instanceMembers,
            args,
            ctx,
            instance,
          ),
          totalCount() {
            return ctx.db.$count(
              instanceMembers,
              and(
                eq(instanceMembers.instanceId, instance.id),
                isNotNull(instanceMembers.accepted),
              ),
            );
          },
        };
      },
    },
    {
      fields(fb) {
        return {
          totalCount: fb.int({
            description:
              "The total number of `Account`s that belong to the `Instance`." +
              "Note that pending members are not counted.",
            resolve(connection) {
              return connection.totalCount();
            },
          }),
        };
      },
    },
    {
      fields(fb) {
        return {
          created: fb.expose("created", {
            type: "DateTime",
            description:
              "The date/time when the `Account` was added to the `Instance`.",
          }),
          accepted: fb.expose("accepted", {
            type: "DateTime",
            nullable: true,
            description:
              "The date/time when the `Account` accepted membership in the `Instance`.",
          }),
          admin: fb.exposeBoolean("admin", {
            description:
              "Whether the `Account` has administrator privileges in the `Instance`.",
          }),
        };
      },
    },
  ),
);

export const CreateInstanceErrorType = builder.enumType(
  "CreateInstanceErrorType",
  {
    values: ["SlugAlreadyTaken", "TooManyInstances"] as const,
  },
);

interface CreateInstanceError {
  readonly type: typeof CreateInstanceErrorType.$inferType;
  readonly message: string;
}

export const CreateInstanceErrorRef = builder.objectRef<CreateInstanceError>(
  "CreateInstanceError",
);

CreateInstanceErrorRef.implement({
  description:
    "Represents an error that occurred while creating an `Instance`.",
  fields: (t) => ({
    type: t.expose("type", {
      type: CreateInstanceErrorType,
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

export const CreateInstanceResult = builder.unionType("CreateInstanceResult", {
  types: [InstanceRef, CreateInstanceErrorRef],
  resolveType(value) {
    if ("message" in value) return CreateInstanceErrorRef;
    return InstanceRef;
  },
});

builder.mutationFields((t) => ({
  createInstance: t.field({
    type: CreateInstanceResult,
    description: "Create an instance.",
    authScopes: { authenticated: true },
    args: {
      slug: t.arg({
        type: "String",
        required: true,
        description:
          "A unique instance slug, which will be a part of the instance " +
          "domain name (e.g., `slug.drfed.net`).",
      }),
    },
    async resolve(_query, { slug }, ctx) {
      if (ctx.account == null) {
        // Note that the following error is not expected to be thrown,
        // because the `authScopes` option above should prevent this resolver
        throw new Error("You must be authenticated to create an instance.");
      }
      const { account } = ctx;
      let tooManyInstances = false;
      try {
        return await ctx.db.transaction(async (tx) => {
          const [instance] = await tx
            .insert(schema.instances)
            .values({
              id: uuid(),
              slug,
              expires: new Date(
                Temporal.Now.instant().add({ hours: 8750 }).toString(),
              ),
            })
            .returning();
          if (instance == null) throw new Error("Failed to create instance.");
          await tx.insert(schema.instanceMembers).values({
            instanceId: instance.id,
            accountId: account.id,
          });
          const instances = await tx.$count(
            schema.instanceMembers,
            eq(schema.instanceMembers.accountId, account.id),
          );
          if (instances > account.maxInstances) {
            tooManyInstances = true;
            tx.rollback();
          }
          return instance;
        });
      } catch (e) {
        if (tooManyInstances) {
          return {
            type: "TooManyInstances" as const,
            message: `You have reached the maximum number of instances (${account.maxInstances}).`,
          };
        }
        if (
          e instanceof DrizzleQueryError &&
          e.cause != null &&
          "constraint" in e.cause &&
          e.cause.constraint === "instances_slug_key"
        ) {
          return {
            message: `The slug ${JSON.stringify(slug)} is already taken.`,
            type: "SlugAlreadyTaken" as const,
          };
        }
        throw e;
      }
    },
  }),
}));
