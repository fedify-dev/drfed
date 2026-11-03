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

import {
  createLegacyObject,
  isLocalWriteError,
} from "@drfed/federation/local-write";
import { schema } from "@drfed/models";
import { objectTypeEnum } from "@drfed/models/schema";
import { validateUuid } from "@drfed/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { and, eq, isNull } from "drizzle-orm";

import { Actor } from "./actor.ts";
import builder, { type DrFedObjectRef } from "./builder.ts";
import { readableResource } from "./readable.ts";
import {
  Activity,
  ActivityType,
  ResourceDetail,
  registerAddressingFields,
} from "./resource.ts";

const ObjectType = builder.enumType("ObjectType", {
  values: objectTypeEnum.enumValues,
});
const AddressingInput = builder.inputType("AddressingInput", {
  fields: (t) => ({
    to: t.field({ type: ["URL"], required: true, defaultValue: [] }),
    cc: t.field({ type: ["URL"], required: true, defaultValue: [] }),
    bto: t.field({ type: ["URL"], required: true, defaultValue: [] }),
    bcc: t.field({ type: ["URL"], required: true, defaultValue: [] }),
    audience: t.field({ type: ["URL"], required: true, defaultValue: [] }),
  }),
});
const ObjectRef = builder.drizzleNode("objects", {
  name: "Object",
  select: {
    columns: { id: true, deleted: true },
    with: { actor: { columns: { deleted: true } } },
  },
  description:
    "Represents an ActivityPub object authored by an `Actor`.  An object of " +
    "a local actor is readable whatever its addressing.  One of a remote " +
    "actor is readable only when it or the activity it was received in is " +
    "addressed to the public, by members of the local instances that " +
    "received that activity and the object as stored with it, and by " +
    "administrators; otherwise it is left out as if it did not exist.",
  id: {
    column: ({ id }) => id,
    description: "The Relay global ID of the object.",
  },
  fields: (t) => ({
    resource: t.relation("resource"),
    iri: t.field({
      type: "URL",
      select: { with: { resource: true } },
      resolve: (row) => row.resource.iri,
    }),
    uuid: t.expose("id", {
      type: "UUID",
      description: "The UUID of the ActivityPub Object.",
    }),
    url: t.expose("url", {
      type: "URL",
      nullable: true,
      description: "The human-readable page URL, if available.",
    }),
    type: t.expose("type", {
      type: ObjectType,
      description: "The ActivityStreams vocabulary type: Note or Article.",
    }),
    actor: t.relation("actor", {
      description: "The actor that authored the object.",
    }),
    document: t.expose("document", {
      type: "JSON",
      nullable: true,
      description:
        "The JSON-LD document of the object.  For a remote object embedded in the Create that delivered it, the object as received; null when it was not found within the first 64 places of that document, in which case the document of the Create, reachable through activities, holds it as received.",
    }),
    name: t.exposeString("name", {
      nullable: true,
      description: "The optional title of the object.",
    }),
    summary: t.exposeString("summary", {
      nullable: true,
      description: "The optional summary or content warning.",
    }),
    contentHtml: t.exposeString("contentHtml", {
      description:
        "HTML preserved verbatim. Clients must sanitize it before browser rendering.",
    }),
    language: t.exposeString("language", {
      nullable: true,
      description:
        "The canonical BCP 47 tag used for contentMap, if specified.",
    }),
    sensitive: t.exposeBoolean("sensitive", {
      description: "Whether the content is marked sensitive.",
    }),
    published: t.expose("published", {
      type: "DateTime",
      description: "The ActivityStreams publication time.",
    }),
    updated: t.expose("updated", {
      type: "DateTime",
      description: "The time the stored object was last updated.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description:
        "The time the object was stored in DrFed, distinct from its publication time.",
    }),
  }),
});
export const ActivityPubObject: DrFedObjectRef = ObjectRef;
ResourceDetail.addTypes([ActivityPubObject]);
registerAddressingFields("objects");

const activitiesConnection = drizzleConnectionHelpers(builder, "activities", {
  query: (
    args: {
      type?: typeof schema.activities.$inferSelect.type | null;
    },
    ctx,
  ) => ({
    where: {
      actor: { deleted: { isNull: true } },
      ...(args.type == null ? {} : { type: args.type }),
      RAW: (table) => readableResource(ctx, table.id),
    },
    orderBy: { published: "asc", id: "asc" },
  }),
});
builder.drizzleObjectField("objects", "activities", (t) =>
  t.connection({
    type: Activity,
    args: { type: t.arg({ type: ActivityType }) },
    description:
      "Activities referencing this object that the viewer may read, optionally filtered by type. Excludes deleted authors; ordered by published ASC, id ASC.",
    select(args, ctx, nestedSelection) {
      return {
        with: {
          activities: activitiesConnection.getQuery(args, ctx, nestedSelection),
        },
      };
    },
    resolve: (object, args, ctx) =>
      activitiesConnection.resolve(object.activities, args, ctx, object),
  }),
);

const objectsConnection = drizzleConnectionHelpers(builder, "objects", {
  query: (_, ctx) => ({
    where: { RAW: (table) => readableResource(ctx, table.id) },
    orderBy: { published: "desc", id: "desc" },
  }),
});
builder.drizzleObjectField("actors", "objects", (t) =>
  t.connection(
    {
      type: ActivityPubObject,
      description:
        "Non-deleted objects the viewer may read, newest publication first. A local actor's objects are readable whatever their addressing; see `Object` for a remote actor's.",
      select(args, ctx, nestedSelection) {
        return {
          with: {
            objects: objectsConnection.getQuery(args, ctx, nestedSelection),
          },
        };
      },
      resolve(actor, args, ctx) {
        return {
          ...objectsConnection.resolve(actor.objects, args, ctx, actor),
          totalCount() {
            return ctx.db.$count(
              schema.objects,
              and(
                eq(schema.objects.actorId, actor.id),
                isNull(schema.objects.deleted),
                readableResource(ctx, schema.objects.id),
              ),
            );
          },
        };
      },
    },
    {
      name: "ObjectConnection",
      fields: (fb) => ({
        totalCount: fb.int({
          description:
            "The number of non-deleted objects authored by this actor that the viewer may read.",
          resolve: (connection) => connection.totalCount(),
        }),
      }),
    },
    { name: "ObjectEdge" },
  ),
);

const CreateObjectErrorType = builder.enumType("CreateObjectErrorType", {
  values: [
    "ActorNotFound",
    "InvalidContent",
    "InvalidInstanceHost",
    "InvalidLanguage",
  ] as const,
});
interface CreateObjectError {
  readonly type: typeof CreateObjectErrorType.$inferType;
  readonly message: string;
}
const CreateObjectErrorRef =
  builder.objectRef<CreateObjectError>("CreateObjectError");
CreateObjectErrorRef.implement({
  fields: (t) => ({
    type: t.expose("type", {
      type: CreateObjectErrorType,
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
const CreateObjectResult = builder.unionType("CreateObjectResult", {
  types: [ObjectRef, CreateObjectErrorRef],
  resolveType: (value) =>
    "message" in value ? CreateObjectErrorRef : ObjectRef,
});
const actorNotFound: CreateObjectError = {
  type: "ActorNotFound",
  message: "Can't find the actor.",
};

builder.mutationFields((t) => ({
  createObject: t.field({
    type: CreateObjectResult,
    description:
      "Create a local Note or Article together with a `Create` activity in " +
      "the author's outbox, without delivering it to remote servers.  This " +
      "mutation keeps that established behavior; it does not save an object " +
      "alone.",
    authScopes: { authenticated: true },
    args: {
      actor: t.arg.globalID({
        for: Actor,
        required: true,
        description:
          "The local author actor ID. The viewer must be an accepted instance member.",
      }),
      type: t.arg({
        type: ObjectType,
        required: true,
        defaultValue: "Note",
        description: "The ActivityStreams object type to create.",
      }),
      contentHtml: t.arg.string({
        required: true,
        description:
          "Non-empty HTML stored verbatim; browser clients must sanitize it before rendering.",
      }),
      name: t.arg.string({
        description:
          "Optional title. Empty or whitespace-only values are stored as null.",
      }),
      summary: t.arg.string({
        description:
          "Optional summary or content warning. Empty or whitespace-only values are stored as null.",
      }),
      language: t.arg.string({
        description:
          "A BCP 47 language tag, canonicalized and limited to 35 characters.",
      }),
      sensitive: t.arg.boolean({
        required: true,
        defaultValue: false,
        description: "Whether to mark the content as sensitive.",
      }),
      addressing: t.arg({
        type: AddressingInput,
        required: true,
        description:
          "Explicit addressing preserved in order, including duplicates. Empty lists are allowed.",
      }),
    },
    async resolve(
      _parent,
      { actor: { id: actorId }, language, addressing, ...input },
      ctx,
    ) {
      if (input.contentHtml.trim() === "") {
        return {
          type: "InvalidContent" as const,
          message: "Content must not be empty.",
        };
      }
      let canonicalLanguage: string | null = null;
      if (language != null) {
        try {
          canonicalLanguage = Intl.getCanonicalLocales(language)[0] ?? null;
          if (canonicalLanguage == null || canonicalLanguage.length > 35) {
            throw new RangeError("Language tag is too long.");
          }
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          return {
            type: "InvalidLanguage" as const,
            message:
              "Language must be a valid BCP 47 tag of at most 35 characters.",
          };
        }
      }
      const { account } = ctx;
      if (account == null) {
        throw new Error("You must be authenticated to create objects.");
      }
      if (!validateUuid(actorId)) return actorNotFound;
      const result = await createLegacyObject(
        ctx,
        { accountId: account.id },
        {
          ...input,
          actorId,
          name: normalizeOptionalText(input.name),
          summary: normalizeOptionalText(input.summary),
          language: canonicalLanguage,
          addressing,
        },
      );
      if (!isLocalWriteError(result)) return result;
      return result.type === "invalid_instance_host"
        ? { type: "InvalidInstanceHost" as const, message: result.message }
        : actorNotFound;
    },
  }),
}));

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  return value == null || value.trim() === "" ? null : value;
}
