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
  addActorCollectionItem,
  promoteResource,
  schema,
  storeAddressing,
} from "@drfed/models";
import { objectTypeEnum } from "@drfed/models/schema";
import { uuidV7 as uuid, validateUuid } from "@drfed/models/uuid";
import { Object as APObject, Create } from "@fedify/vocab";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";

import { Actor } from "./actor.ts";
import builder, { type DrFedObjectRef } from "./builder.ts";
import {
  type AddressingRows,
  classifyMastodon,
  classifyMisskey,
} from "./classification.ts";
import {
  activitySelection,
  objectSelection,
  toCreate,
  toObject,
} from "./federation.ts";
import { Resource, registerAddressingFields } from "./resource.ts";

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
const Implementation = builder.enumType("Implementation", {
  values: ["MASTODON", "MISSKEY"] as const,
});
const ExpectedClassification = builder.objectRef<
  ReturnType<typeof classifyMastodon>
>("ExpectedClassification");
ExpectedClassification.implement({
  description:
    "Expected classification; actual access depends on receiver state and policy.",
  fields: (t) => ({
    implementation: t.expose("implementation", { type: Implementation }),
    version: t.exposeString("version"),
    classification: t.exposeString("classification"),
    reason: t.exposeString("reason"),
  }),
});
const ObjectRef = builder.drizzleNode("objects", {
  name: "Object",
  select: {
    columns: { id: true, deleted: true },
    with: { actor: { columns: { deleted: true } } },
  },
  interfaces: [Resource],
  description: "Represents an ActivityPub object authored by an `Actor`.",
  id: {
    column: ({ id }) => id,
    description: "The Relay global ID of the object.",
  },
  fields: (t) => ({
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
    document: t.expose("document", { type: "JSON", nullable: true }),
    createActivity: t.relation("createActivity", {
      nullable: true,
      query: { where: { actor: { deleted: { isNull: true } } } },
    }),
    expectedClassifications: t.field({
      type: [ExpectedClassification],
      select: { columns: { id: true } },
      resolve: async (object, _, ctx) => {
        const row = await ctx.db.query.objects.findFirst({
          where: { id: object.id },
          with: {
            ...objectSelection,
            actor: {
              with: {
                resource: true,
                collectionReferences: {
                  with: { collection: { with: { resource: true } } },
                },
              },
            },
            createActivity: { with: activitySelection },
          },
        });
        if (row == null) throw new Error("Missing object.");
        const author = {
          iri: row.actor.resource.iri,
          followersIri:
            row.actor.collectionReferences.find(
              (collection) => collection.role === "followers",
            )?.collection.resource.iri ?? null,
        };
        const addressing = classificationInput(row);
        const activity =
          row.createActivity == null
            ? null
            : classificationInput(row.createActivity);
        return [
          classifyMastodon(addressing, activity, author),
          classifyMisskey(addressing, activity, author),
        ];
      },
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
registerAddressingFields("objects");

const objectsConnection = drizzleConnectionHelpers(builder, "objects", {
  query: {
    orderBy: { published: "desc", id: "desc" },
  },
});
builder.drizzleObjectField("actors", "objects", (t) =>
  t.connection(
    {
      type: ActivityPubObject,
      description:
        "Non-deleted objects, newest publication first. All addressing is publicly readable through GraphQL.",
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
            "The number of non-deleted objects authored by this actor, regardless of addressing.",
          resolve: (connection) => connection.totalCount(),
        }),
      }),
    },
    { name: "ObjectEdge" },
  ),
);

const CreateObjectErrorType = builder.enumType("CreateObjectErrorType", {
  values: ["ActorNotFound", "InvalidContent", "InvalidLanguage"] as const,
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
      "Create a local ActivityPub object without delivering it to remote servers.",
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
      return await ctx.db.transaction(async (tx) => {
        const [actor] = await tx
          .select({ id: schema.actors.id, host: schema.instances.host })
          .from(schema.actors)
          .for("update", { of: schema.actors })
          .innerJoin(
            schema.instances,
            eq(schema.actors.instanceId, schema.instances.id),
          )
          .innerJoin(
            schema.localInstances,
            eq(schema.instances.localId, schema.localInstances.id),
          )
          .innerJoin(
            schema.instanceMembers,
            eq(schema.instanceMembers.instanceId, schema.instances.id),
          )
          .where(
            and(
              eq(schema.actors.id, actorId),
              isNotNull(schema.actors.localId),
              isNull(schema.actors.deleted),
              gt(schema.localInstances.expires, Temporal.Now.instant()),
              eq(schema.instanceMembers.accountId, account.id),
              isNotNull(schema.instanceMembers.accepted),
            ),
          )
          .limit(1);
        if (actor == null) return actorNotFound;
        const id = uuid();
        const fedCtx = ctx.federation.createContext(
          new URL(`https://${actor.host}`),
          undefined,
        );
        const iri = fedCtx.getObjectUri(APObject, {
          identifier: actorId,
          id,
        }).href;
        const object = await promoteResource(
          tx,
          iri,
          "object",
          async (inner, resource) => {
            const [row] = await inner
              .insert(schema.objects)
              .values({
                ...input,
                name: normalizeOptionalText(input.name),
                summary: normalizeOptionalText(input.summary),
                id: resource.id,
                actorId,
                language: canonicalLanguage,
              })
              .returning();
            if (row == null) {
              throw new Error("Object insertion returned no row.");
            }
            return row;
          },
          id,
        );
        await storeAddressing(tx, object.id, addressing);
        const activityId = uuid();
        await promoteResource(
          tx,
          fedCtx.getObjectUri(Create, { id: activityId }).href,
          "activity",
          async (inner, resource) => {
            await inner.insert(schema.activities).values({
              id: resource.id,
              type: "Create",
              actorId,
              objectId: object.id,
              published: object.published,
            });
            await storeAddressing(inner, resource.id, addressing);
            await addActorCollectionItem(inner, actorId, "outbox", resource.id);
          },
          activityId,
        );
        const storedObject = await tx.query.objects.findFirst({
          where: { id: object.id },
          with: objectSelection,
        });
        const storedActivity = await tx.query.activities.findFirst({
          where: { id: activityId },
          with: activitySelection,
        });
        if (storedObject == null || storedActivity == null) {
          throw new Error("Missing newly created resource.");
        }
        // Preserve blind recipients in the local snapshot; serving strips them.
        const snapshot = {
          ...asDocument(await toObject(fedCtx, storedObject).toJsonLd()),
          ...addressing,
        };
        await tx
          .update(schema.objects)
          .set({ document: snapshot, updated: object.updated })
          .where(eq(schema.objects.id, object.id));
        await tx
          .update(schema.activities)
          .set({
            document: {
              ...asDocument(await toCreate(fedCtx, storedActivity).toJsonLd()),
              ...addressing,
            },
          })
          .where(eq(schema.activities.id, activityId));
        return { ...object, actor: storedObject.actor, document: snapshot };
      });
    },
  }),
}));

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  return value == null || value.trim() === "" ? null : value;
}

function classificationInput(row: {
  document: unknown;
  addressing: readonly {
    property: string;
    position: number;
    targetResource: { iri: string };
  }[];
}): AddressingRows {
  const property = (name: "to" | "cc"): readonly string[] | undefined => {
    const rows = row.addressing
      .filter((entry) => entry.property === name)
      .toSorted((left, right) => left.position - right.position);
    if (rows.length > 0) return rows.map((entry) => entry.targetResource.iri);
    const { document } = row;
    return document != null &&
      typeof document === "object" &&
      name in document &&
      document[name as keyof typeof document] != null
      ? []
      : undefined;
  };
  return { to: property("to"), cc: property("cc") };
}

function asDocument(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a JSON-LD object.");
  }
  return value as Record<string, unknown>;
}
