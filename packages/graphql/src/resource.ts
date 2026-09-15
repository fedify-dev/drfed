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
import { eq } from "drizzle-orm";

import builder from "./builder.ts";

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
 * @returns The entity represented by this resource, or the unknown resource itself.
 */
export async function resolveResource(
  db: Database,
  row: ResourceRow,
): Promise<{ id: Uuid }> {
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
      resolve: (row, _, ctx) => resolveResource(ctx.db, row.targetResource),
    }),
    raw: t.expose("target", {
      type: "JSON",
      nullable: true,
      description: "The original inline object or Link, if present.",
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
export const Collection = builder.drizzleNode("collections", {
  name: "Collection",
  interfaces: [Resource],
  id: { column: (row) => row.id },
  fields: (t) => ({
    type: t.expose("type", { type: CollectionType }),
    role: t.expose("role", { type: CollectionRole, nullable: true }),
    owner: t.relation("ownerActor", { nullable: true }),
    totalCount: t.int({
      select: { columns: { id: true, totalItems: true } },
      resolve: (row, _, ctx) =>
        row.totalItems ??
        ctx.db.$count(
          schema.collectionItems,
          eq(schema.collectionItems.collectionId, row.id),
        ),
    }),
    items: t.connection({
      type: Resource,
      select: { columns: { id: true } },
      resolve: (row, args, ctx) =>
        resolveOffsetConnection({ args }, async ({ offset, limit }) => {
          const items = await ctx.db.query.collectionItems.findMany({
            where: { collectionId: row.id },
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
const ActivityType = builder.enumType("ActivityType", {
  values: schema.activityTypeEnum.enumValues,
});
export const Activity = builder.drizzleNode("activities", {
  name: "Activity",
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
registerAddressingFields("activities");
