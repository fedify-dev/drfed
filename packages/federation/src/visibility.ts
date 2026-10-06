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
import { PUBLIC_RESOURCE_ID } from "@drfed/models/resource";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

/**
 * Shared Public predicate for object, activity, outbox page and counter.
 * @returns An EXISTS predicate matching explicit Public addressing.
 */
export function publicAddressing(sourceId: SQLWrapper): SQL {
  return sql`exists (select 1 from ${schema.addressing} where ${schema.addressing.sourceId} = ${sourceId} and ${schema.addressing.targetId} = ${PUBLIC_RESOURCE_ID} and ${schema.addressing.property} in ('to', 'cc'))`;
}

/**
 * Matches the activities that are served over ActivityPub: Public `Create`
 * activities whose object has not been deleted.  The Create dispatcher, the
 * outbox pages and the outbox counter share it, so that none of them can
 * disagree with the others about what is served.
 * @returns A predicate on the activities table.
 */
export function servedActivity(table: {
  id: SQLWrapper;
  objectId: SQLWrapper;
  type: SQLWrapper;
}): SQL {
  return sql`${table.type} = 'Create' and ${publicAddressing(table.id)} and exists (select 1 from ${schema.objects} where ${schema.objects.id} = ${table.objectId} and ${schema.objects.deleted} is null)`;
}
