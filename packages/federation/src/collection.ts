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

import type { Database } from "@drfed/models";
import type { Uuid } from "@drfed/models/uuid";
import type { Context, FederationBuilder } from "@fedify/fedify";
import { Object as APObject } from "@fedify/vocab";

import { findActiveActor } from "./actor.ts";
import { countOutbox, loadOutboxPage } from "./serving/resource.ts";

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
        const actor = await findActiveActor(db, ctx, identifier);
        if (actor == null) return null;
        const after = parseOutboxCursor(cursor);
        if (after === false) return null;
        const outboxId = outboxOf(actor);
        if (outboxId == null) return { items: [] };
        const page = await loadOutboxPage(
          db,
          ctx,
          outboxId,
          after,
          OUTBOX_PAGE_SIZE,
        );
        return {
          items: [...page.items],
          nextCursor: page.nextCursor == null ? null : String(page.nextCursor),
        };
      },
    )
    .setFirstCursor(async (ctx, identifier) =>
      (await findActiveActor(db, ctx, identifier)) == null ? null : "",
    )
    .setCounter(async (ctx, identifier) => {
      const actor = await findActiveActor(db, ctx, identifier);
      if (actor == null) return null;
      const outboxId = outboxOf(actor);
      return outboxId == null ? 0 : await countOutbox(db, outboxId);
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
 * Reads the outbox collection an actor declares.
 * @returns The collection ID, or `null` when it declares none.
 */
function outboxOf(actor: {
  readonly collectionReferences: readonly {
    readonly role: string;
    readonly collectionId: Uuid;
  }[];
}): Uuid | null {
  return (
    actor.collectionReferences.find(({ role }) => role === "outbox")
      ?.collectionId ?? null
  );
}

/**
 * Parses an outbox cursor: the position of the last item of the previous
 * page.
 * @returns The position, null for the first page, or false for invalid input.
 */
function parseOutboxCursor(cursor: string | null): number | null | false {
  if (cursor == null || cursor === "") return null;
  if (!/^-?\d{1,10}$/u.test(cursor)) return false;
  const position = Number(cursor);
  // Positions are PostgreSQL integers.
  return position >= -(2 ** 31) && position < 2 ** 31 ? position : false;
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
