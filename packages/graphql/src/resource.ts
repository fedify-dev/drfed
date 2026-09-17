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

import { type Database, schema } from "@drfed/models";
import type { Resource as ResourceRow } from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import { resolveOffsetConnection } from "@pothos/plugin-relay";
import { type SQL, type SQLWrapper, and, eq, sql } from "drizzle-orm";

import builder, { type DrFedObjectRef } from "./builder.ts";
import {
  classificationAuthor,
  classificationInput,
  classifyMastodon,
  classifyMisskey,
} from "./classification.ts";
import { activitySelection, objectSelection } from "./federation.ts";

export const ResourceKind = builder.enumType("ResourceKind", {
  values: schema.resourceKindEnum.enumValues,
});
export const ResourceDetail = builder.unionType("ResourceDetail", {
  types: () => [Activity, Collection],
  resolveType: async (value, ctx) => {
    const { id } = value as { id: Uuid };
    const row = await ctx.db.query.resources.findFirst({ where: { id } });
    if (row == null || row.kind === "unknown") {
      throw new Error("Missing typed resource.");
    }
    return (
      {
        actor: "Actor",
        object: "Object",
        activity: "Activity",
        collection: "Collection",
      } as const
    )[row.kind];
  },
});
const ResourceRef = builder.drizzleNode("resources", {
  name: "Resource",
  id: { column: (row) => row.id },
  fields: (t) => ({
    iri: t.expose("iri", { type: "URL" }),
    kind: t.expose("kind", { type: ResourceKind }),
    detail: t.field({
      type: ResourceDetail,
      nullable: true,
      description:
        "Typed details, or null while unknown or when the typed row or its author/owner is deleted.",
      select: { columns: { id: true, iri: true, kind: true } },
      resolve: (row, _, ctx) => resolveResource(ctx.db, row),
    }),
  }),
});
export const Resource: DrFedObjectRef = ResourceRef;

/**
 * Loads the typed record so union fragments see the complete entity.
 * @returns The typed entity, or null when it or its author is deleted.
 */
export async function resolveResource(
  db: Database,
  row: ResourceRow,
): Promise<{ id: Uuid } | null> {
  const visible = await db.query.resources.findFirst({
    where: { id: row.id, RAW: (table) => visibleResource(table.id) },
    columns: { id: true },
  });
  if (visible == null) return null;
  if (row.kind === "unknown") return null;
  const where = { id: row.id };
  const result =
    row.kind === "actor"
      ? await db.query.actors.findFirst({ where })
      : row.kind === "object"
        ? await db.query.objects.findFirst({ where })
        : row.kind === "activity"
          ? await db.query.activities.findFirst({ where })
          : await db.query.collections.findFirst({ where });
  if (result == null) {
    throw new Error(`Missing ${row.kind} record for ${row.iri}.`);
  }
  return result;
}

export function registerAddressingFields(
  table: "objects" | "activities",
): void {
  for (const property of schema.addressingPropertyEnum.enumValues) {
    builder.drizzleObjectField(table, property, (t) =>
      t.field({
        type: [Resource],
        description: `Stored ${property} occurrences, in original order including duplicates.`,
        select: { columns: { id: true } },
        resolve: async (row, _, ctx) =>
          (
            await ctx.db.query.addressing.findMany({
              where: { sourceId: row.id, property },
              orderBy: { position: "asc" },
              with: { targetResource: true },
            })
          ).map((entry) => entry.targetResource),
      }),
    );
  }
}

const CollectionType = builder.enumType("CollectionType", {
  values: schema.collectionTypeEnum.enumValues,
});
const CollectionRef = builder.drizzleNode("collections", {
  name: "Collection",
  select: {
    columns: { id: true },
    with: { ownerActor: { columns: { deleted: true } } },
  },
  id: { column: (row) => row.id },
  fields: (t) => ({
    resource: t.relation("resource"),
    iri: t.field({
      type: "URL",
      select: { with: { resource: true } },
      resolve: (row) => row.resource.iri,
    }),
    type: t.expose("type", { type: CollectionType }),
    owner: t.relation("ownerActor", {
      nullable: true,
      query: { where: { deleted: { isNull: true } } },
    }),
    declaredTotalItems: t.exposeInt("totalItems", {
      nullable: true,
      description:
        "The `totalItems` reported by the collection document. It can differ from the locally observed count and is null for local collections. Unlike `totalCount` and `items`, this value is not recalculated when deleted actors, deleted objects, or resources authored by deleted actors are excluded.",
    }),
    totalCount: t.int({
      description:
        "The number of locally stored, visible members. It can differ from `declaredTotalItems`. Deleted actors, deleted objects, and resources authored by deleted actors are excluded from this count and `items`.",
      select: { columns: { id: true } },
      resolve: (row, _, ctx) =>
        ctx.db.$count(
          schema.collectionItems,
          and(
            eq(schema.collectionItems.collectionId, row.id),
            visibleResource(schema.collectionItems.itemId),
          ),
        ),
    }),
    items: t.connection({
      type: Resource,
      description:
        "The locally stored, visible members. Deleted actors, deleted objects, and resources authored by deleted actors are excluded from this connection and `totalCount`.",
      select: { columns: { id: true } },
      resolve: (row, args, ctx) =>
        resolveOffsetConnection({ args }, async ({ offset, limit }) => {
          const items = await ctx.db.query.collectionItems.findMany({
            where: {
              collectionId: row.id,
              RAW: (table) => visibleResource(table.itemId),
            },
            orderBy: { position: "asc", itemId: "asc" },
            offset,
            limit,
            with: { item: true },
          });
          return items.map((item) => item.item);
        }),
    }),
  }),
});
export const Collection: DrFedObjectRef = CollectionRef;

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
export const ActivityType = builder.enumType("ActivityType", {
  values: schema.activityTypeEnum.enumValues,
});
const ActivityRef = builder.drizzleNode("activities", {
  name: "Activity",
  select: {
    columns: { id: true },
    with: { actor: { columns: { deleted: true } } },
  },
  id: { column: (row) => row.id },
  fields: (t) => ({
    resource: t.relation("resource"),
    iri: t.field({
      type: "URL",
      select: { with: { resource: true } },
      resolve: (row) => row.resource.iri,
    }),
    type: t.expose("type", { type: ActivityType }),
    actor: t.relation("actor"),
    object: t.field({
      type: Resource,
      nullable: true,
      select: { with: { object: true } },
      resolve: (row) => row.object,
    }),
    expectedClassifications: t.field({
      type: [ExpectedClassification],
      description:
        "Expected classifications for this activity and its Object. Empty if the object is absent, hidden, or not an Object.",
      select: { columns: { id: true } },
      resolve: async (activity, _, ctx) => {
        const row = await ctx.db.query.activities.findFirst({
          where: { id: activity.id },
          with: activitySelection,
        });
        if (row?.objectId == null) return [];
        const object = await ctx.db.query.objects.findFirst({
          where: {
            id: row.objectId,
            deleted: { isNull: true },
            actor: { deleted: { isNull: true } },
          },
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
          },
        });
        if (object == null) return [];
        const addressing = classificationInput(object);
        const input = classificationInput(row);
        const author = classificationAuthor(object.actor);
        return [
          classifyMastodon(addressing, input, author),
          classifyMisskey(addressing, input, author),
        ];
      },
    }),
    published: t.expose("published", { type: "DateTime" }),
    document: t.expose("document", { type: "JSON", nullable: true }),
  }),
});
export const Activity: DrFedObjectRef = ActivityRef;
registerAddressingFields("activities");

/**
 * Excludes deleted actors and objects, including resources authored or
 * owned by deleted actors.
 * @returns A predicate for a resource ID in an outer query.
 */
function visibleResource(id: SQLWrapper): SQL {
  return sql`not exists (
    select 1 from ${schema.actors}
    where ${schema.actors.id} = ${id} and ${schema.actors.deleted} is not null
  ) and not exists (
    select 1 from ${schema.objects}
    join ${schema.actors} on ${schema.actors.id} = ${schema.objects.actorId}
    where ${schema.objects.id} = ${id}
      and (${schema.objects.deleted} is not null or ${schema.actors.deleted} is not null)
  ) and not exists (
    select 1 from ${schema.activities}
    join ${schema.actors} on ${schema.actors.id} = ${schema.activities.actorId}
    where ${schema.activities.id} = ${id} and ${schema.actors.deleted} is not null
  ) and not exists (
    select 1 from ${schema.collections}
    join ${schema.actors} on ${schema.actors.id} = ${schema.collections.ownerActorId}
    where ${schema.collections.id} = ${id} and ${schema.actors.deleted} is not null
  )`;
}
