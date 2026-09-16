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

export const ResourceKind = builder.enumType("ResourceKind", {
  values: schema.resourceKindEnum.enumValues,
});
export const Resource = builder.interfaceRef<{ id: Uuid }>("Resource");
Resource.implement({
  fields: (t) => ({
    iri: t.field({
      type: "URL",
      resolve: async ({ id }, _, ctx) => {
        const row = await ctx.db.query.resources.findFirst({ where: { id } });
        if (row == null) throw new Error("Missing resource.");
        return row.iri;
      },
    }),
    kind: t.field({
      type: ResourceKind,
      resolve: async ({ id }, _, ctx) => {
        const row = await ctx.db.query.resources.findFirst({ where: { id } });
        if (row == null) throw new Error("Missing resource.");
        return row.kind;
      },
    }),
  }),
  resolveType: async ({ id }, ctx) => {
    const row = await ctx.db.query.resources.findFirst({ where: { id } });
    return (
      {
        actor: "Actor",
        object: "Object",
        activity: "Activity",
        collection: "Collection",
        unknown: "UnknownResource",
      } as const
    )[row?.kind ?? "unknown"];
  },
});

/**
 * Loads the typed record so interface fragments see the complete entity.
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
  if (row.kind === "unknown") return row;
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

builder.drizzleNode("resources", {
  name: "UnknownResource",
  interfaces: [Resource],
  id: { column: (row) => row.id },
  fields: () => ({}),
});
const AddressingTarget = builder.objectRef<
  typeof schema.addressing.$inferSelect & { targetResource: ResourceRow }
>("AddressingTarget");
AddressingTarget.implement({
  fields: (t) => ({
    target: t.field({
      type: Resource,
      nullable: true,
      description:
        "The target resource, or null if it or its author is deleted.",
      resolve: (row, _, ctx) => resolveResource(ctx.db, row.targetResource),
    }),
  }),
});

export function registerAddressingFields(
  table: "objects" | "activities",
): void {
  for (const property of schema.addressingPropertyEnum.enumValues) {
    builder.drizzleObjectField(table, property, (t) =>
      t.field({
        type: [AddressingTarget],
        description: `Stored ${property} occurrences, in original order including duplicates.`,
        select: { columns: { id: true } },
        resolve: (row, _, ctx) =>
          ctx.db.query.addressing.findMany({
            where: { sourceId: row.id, property },
            orderBy: { position: "asc" },
            with: { targetResource: true },
          }),
      }),
    );
  }
}

const CollectionType = builder.enumType("CollectionType", {
  values: schema.collectionTypeEnum.enumValues,
});
const CollectionRole = builder.enumType("CollectionRole", {
  values: schema.collectionRoleEnum.enumValues,
});
const CollectionRef = builder.drizzleNode("collections", {
  name: "Collection",
  select: {
    columns: { id: true },
    with: { ownerActor: { columns: { deleted: true } } },
  },
  interfaces: [Resource],
  id: { column: (row) => row.id },
  fields: (t) => ({
    type: t.expose("type", { type: CollectionType }),
    role: t.expose("role", { type: CollectionRole, nullable: true }),
    owner: t.relation("ownerActor", {
      nullable: true,
      query: { where: { deleted: { isNull: true } } },
    }),
    totalCount: t.int({
      select: { columns: { id: true, totalItems: true } },
      resolve: (row, _, ctx) =>
        row.totalItems ??
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
          return await Promise.all(
            items.map((item) => resolveResource(ctx.db, item.item)),
          );
        }),
    }),
  }),
});
export const Collection: DrFedObjectRef = CollectionRef;

const ActivityType = builder.enumType("ActivityType", {
  values: schema.activityTypeEnum.enumValues,
});
const ActivityRef = builder.drizzleNode("activities", {
  name: "Activity",
  select: {
    columns: { id: true },
    with: { actor: { columns: { deleted: true } } },
  },
  interfaces: [Resource],
  id: { column: (row) => row.id },
  fields: (t) => ({
    type: t.expose("type", { type: ActivityType }),
    actor: t.relation("actor"),
    object: t.field({
      type: Resource,
      nullable: true,
      select: { with: { object: true } },
      resolve: (row, _, ctx) =>
        row.object == null ? null : resolveResource(ctx.db, row.object),
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
