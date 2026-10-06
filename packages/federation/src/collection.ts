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
import { type Uuid, validateUuid } from "@drfed/models/uuid";
import type { Context, FederationBuilder } from "@fedify/fedify";
import { Object as APObject } from "@fedify/vocab";
import { and, eq, sql } from "drizzle-orm";

import { findActiveActor } from "./actor.ts";
import { activitySelection, toCreate } from "./object.ts";
import { servedActivity } from "./visibility.ts";

const OUTBOX_PAGE_SIZE = 20;

/**
 * Registers the dispatchers for the outbox, followers, following, and
 * featured collections of local actors.
 * @param builder The builder to register on.
 * @param db The database to resolve the collections from.
 */
export function registerCollectionDispatchers(
  builder: FederationBuilder<unknown>,
  db: Database,
): void {
  builder
    .setOutboxDispatcher(
      "/users/{identifier}/outbox",
      async (ctx, identifier, cursor) => {
        if ((await findActiveActor(db, ctx, identifier)) == null) return null;
        const boundary = parseOutboxCursor(cursor);
        if (boundary === false) return null;
        const rows = await db.query.activities.findMany({
          where: {
            actorId: identifier as Uuid,
            RAW: (table) =>
              and(
                servedActivity(table),
                boundary == null
                  ? undefined
                  : sql`(${table.published}, ${table.id}) <
                      (${boundary.published}::timestamptz, ${boundary.id}::uuid)`,
              )!,
          },
          // Backfilled activity IDs are UUIDv7, so only publication time
          // determines chronology. Keep full database precision in cursors.
          extras: {
            cursorPublished: (table) =>
              sql<string>`to_char(${table.published} AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          },
          orderBy: { published: "desc", id: "desc" },
          limit: OUTBOX_PAGE_SIZE + 1,
          with: activitySelection,
        });
        const page = rows.slice(0, OUTBOX_PAGE_SIZE);
        return {
          items: page.map((object) => toCreate(ctx, object)),
          nextCursor:
            rows.length > OUTBOX_PAGE_SIZE
              ? `${page.at(-1)!.cursorPublished}|${page.at(-1)!.id}`
              : null,
        };
      },
    )
    .setFirstCursor(async (ctx, identifier) =>
      (await findActiveActor(db, ctx, identifier)) == null ? null : "",
    )
    .setCounter(async (ctx, identifier) => {
      const actor = await findActiveActor(db, ctx, identifier);
      return actor == null
        ? null
        : db.$count(
            schema.activities,
            and(
              eq(schema.activities.actorId, actor.id),
              servedActivity(schema.activities),
            ),
          );
    });

  builder
    .setFollowersDispatcher(
      "/users/{identifier}/followers",
      async (ctx, identifier) => {
        const collection = await actorCollection(
          db,
          ctx,
          identifier,
          "followers",
        );
        if (collection == null) return null;
        // FollowersDispatcher requires actor inboxes for future delivery fan-out.
        return {
          items: collection.items.map(({ item }) => ({
            id: new URL(item.iri),
            inboxId: item.actor == null ? null : new URL(item.actor.inboxUrl),
          })),
        };
      },
    )
    .setCounter(
      async (ctx, identifier) =>
        (await actorCollection(db, ctx, identifier, "followers"))?.items
          .length ?? null,
    );
  builder
    .setFollowingDispatcher(
      "/users/{identifier}/following",
      async (ctx, identifier) => {
        const collection = await actorCollection(
          db,
          ctx,
          identifier,
          "following",
        );
        return collection == null
          ? null
          : { items: collection.items.map(({ item }) => new URL(item.iri)) };
      },
    )
    .setCounter(
      async (ctx, identifier) =>
        (await actorCollection(db, ctx, identifier, "following"))?.items
          .length ?? null,
    );
  builder.setFeaturedDispatcher(
    "/users/{identifier}/featured",
    async (ctx, identifier) => {
      const collection = await actorCollection(db, ctx, identifier, "featured");
      return collection == null
        ? null
        : {
            items: collection.items.map(
              ({ item }) => new APObject({ id: new URL(item.iri) }),
            ),
          };
    },
  );
}

/**
 * Parse an opaque boundary without rounding database microseconds.
 * @returns The boundary, null for the first page, or false for invalid input.
 */
function parseOutboxCursor(
  cursor: string | null,
): { published: string; id: string } | null | false {
  if (cursor == null || cursor === "") return null;
  const [published, id, extra] = cursor.split("|");
  if (
    published == null ||
    published.startsWith("0000-") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(published) ||
    id == null ||
    !validateUuid(id) ||
    extra != null
  ) {
    return false;
  }
  try {
    Temporal.Instant.from(published);
    return { published, id };
  } catch {
    return false;
  }
}

async function actorCollection(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
  role: "followers" | "following" | "featured",
) {
  const actor = await findActiveActor(db, ctx, identifier);
  if (actor == null) return null;
  const reference = await db.query.actorCollectionReferences.findFirst({
    where: { actorId: actor.id, role },
    with: {
      collection: {
        with: {
          items: {
            orderBy: { position: "asc", itemId: "asc" },
            with: { item: { with: { actor: true } } },
          },
        },
      },
    },
  });
  return reference?.collection ?? { items: [] };
}
