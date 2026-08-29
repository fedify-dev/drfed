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
import { DrizzleQueryError } from "drizzle-orm";
import { eq } from "drizzle-orm/sql/expressions";
import { v7 as uuid } from "uuid";

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
    }),
    host: t.exposeString("host"),
    created: t.expose("created", {
      type: "DateTime",
      description: "The creation date/time of the `Instance`.",
    }),
    nodeInfoUrl: t.exposeString("nodeInfoUrl", {
      nullable: true,
    }),
    software: t.exposeString("software", {
      nullable: true,
    }),
    softwareVersion: t.exposeString("softwareVersion", {
      nullable: true,
    }),
  }),
});

export const Instance: DrFedObjectRef = InstanceRef;

const LocalInstanceRef = builder.drizzleNode("localInstances", {
  name: "LocalInstance",
  description:
    "Represents a `LocalInstance`, i.e., an `Instance` hosted by this DrFed " +
    "deployment.  Only accepted members of the `Instance` it backs, and " +
    "site administrators, can read it, because it carries operational " +
    "details such as the expiry date and the actor quota.",
  authScopes(localInstance) {
    return {
      $any: {
        admin: true,
        localInstanceMember: localInstance.id,
      },
    };
  },
  // Check the scopes on the type itself rather than only on each field.
  // Without this, a selection that touches no scoped field still resolves, so
  // `node(id: $id) { __typename }` would answer `"LocalInstance"` to a viewer
  // who may not read one.  Note this closes the data channel only: the
  // presence of the authorization error still tells such a viewer that the ID
  // resolves to an existing `LocalInstance`, since an unknown ID yields a
  // plain `null` with no error.  That residual signal is accepted, as it is
  // for slugs, and it additionally requires already knowing a UUID.
  runScopesOnType: true,
  id: {
    column(instance) {
      return instance.id;
    },
    description: "The unique identifier of the `LocalInstance`.",
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The UUID of the `LocalInstance`.",
    }),
    slug: t.exposeString("slug"),
    expires: t.expose("expires", {
      type: "DateTime",
      description: "The expire date of the instance.",
    }),
    maxActors: t.exposeInt("maxActors"),
  }),
});

export const LocalInstance: DrFedObjectRef = LocalInstanceRef;

builder.drizzleObjectField(InstanceRef, "localInstance", (t) =>
  t.relation("localInstance", {
    nullable: true,
    description:
      "The `LocalInstance` backing the `Instance` when it is hosted by " +
      "this DrFed deployment.  `null` if the `Instance` is remote, i.e., " +
      "hosted by another server on the fediverse.",
  }),
);

builder.drizzleObjectField(LocalInstanceRef, "instance", (t) =>
  t.relation("instance", {
    nullable: true,
    description:
      "The `Instance` this `LocalInstance` backs, which carries the " +
      "federation-facing data such as the host name.",
  }),
);

builder.queryFields((t) => ({
  localInstanceBySlug: t.drizzleField({
    type: LocalInstanceRef,
    nullable: true,
    description:
      "Get a `LocalInstance` by its slug.  Returns `null` if no " +
      "`LocalInstance` has the given slug.",
    authScopes: { authenticated: true },
    args: {
      slug: t.arg({
        type: "String",
        required: true,
        description:
          "The slug of the `LocalInstance` to retrieve, i.e., the label " +
          "that forms the first part of its host name.",
      }),
    },
    resolve(query, _root, { slug }, ctx) {
      return ctx.db.query.localInstances.findFirst(query({ where: { slug } }));
    },
  }),
}));

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
          const [local] = await tx
            .insert(schema.localInstances)
            .values({
              id: uuid(),
              slug,
              expires: new Date(
                Temporal.Now.instant().add({ hours: YEAR_BY_HOURS }).toString(),
              ),
            })
            .returning();
          if (local == null) {
            throw new Error("Failed to create local instance.");
          }
          const host = `${slug}.${ctx.root}`;
          const [instance] = await tx
            .insert(schema.instances)
            .values({ id: uuid(), localId: local.id, host })
            .returning();
          if (instance == null) throw new Error("Failed to create instance.");
          await tx.insert(schema.instanceMembers).values({
            instanceId: instance.id,
            accountId: account.id,
            accepted: new Date(),
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
          e.cause.constraint === "local_instances_slug_key"
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

const YEAR_BY_HOURS = 8760;
