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
import { Object as APObject, Activity, Create } from "@fedify/vocab";

import { findServedActivity, findServedObject } from "./serving/resource.ts";

/**
 * Registers the dispatchers for local objects and their activities.  Saved
 * `Create` activities are allocated IRIs under `/ap/creates/` and the other
 * activities under `/ap/activities/`, through `Context.getObjectUri()`; each
 * route serves only the activities allocated to it.
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
    async (ctx, { identifier, id }) =>
      validateUuid(identifier) && validateUuid(id)
        ? await findServedObject(db, ctx, identifier, id)
        : null,
  );

  builder.setObjectDispatcher<Create, "id">(
    Create,
    "/ap/creates/{id}",
    async (ctx, { id }) => {
      if (!validateUuid(id)) return null;
      const activity = await findServedActivity(db, ctx, id, "create");
      return activity instanceof Create ? activity : null;
    },
  );

  builder.setObjectDispatcher<Activity, "id">(
    Activity,
    "/ap/activities/{id}",
    async (ctx, { id }) =>
      validateUuid(id)
        ? await findServedActivity(db, ctx, id, "activity")
        : null,
  );
}
