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
import { validateUuid } from "@drfed/models/uuid";
import type { FederationBuilder } from "@fedify/fedify";
import { Object as APObject, Create, Tombstone } from "@fedify/vocab";

import {
  activitySelection,
  objectSelection,
  toCreate,
  toObject,
} from "./object.ts";
import { canonicalizeAuthority } from "./origin.ts";
import { publicAddressing, servedActivity } from "./visibility.ts";

/**
 * Registers the dispatchers for local objects and their `Create` activities.
 * @param builder The builder to register on.
 * @param db The database to resolve the objects from.
 */
export function registerObjectDispatchers(
  builder: FederationBuilder<unknown>,
  db: Database,
): void {
  builder.setObjectDispatcher<APObject, "identifier" | "id">(
    APObject,
    "/users/{identifier}/{id}",
    async (ctx, { identifier, id }) => {
      if (!validateUuid(identifier) || !validateUuid(id)) return null;
      const object = await db.query.objects.findFirst({
        where: {
          id,
          actorId: identifier,
          RAW: (table) => publicAddressing(table.id),
          actor: {
            localId: { isNotNull: true },
            deleted: { isNull: true },
            instance: { host: canonicalizeAuthority(ctx.host) },
          },
        },
        with: objectSelection,
      });
      if (object == null) return null;
      if (object.deleted != null) {
        return new Tombstone({
          id: new URL(object.resource.iri),
          deleted: object.deleted,
        });
      }
      return toObject(ctx, object);
    },
  );

  builder.setObjectDispatcher<Create, "id">(
    Create,
    "/ap/creates/{id}",
    async (ctx, { id }) => {
      if (!validateUuid(id)) return null;
      const activity = await db.query.activities.findFirst({
        where: {
          id,
          actor: {
            localId: { isNotNull: true },
            deleted: { isNull: true },
            instance: { host: canonicalizeAuthority(ctx.host) },
          },
          RAW: (table) => servedActivity(table),
        },
        with: activitySelection,
      });
      return activity == null ? null : toCreate(ctx, activity);
    },
  );
}
