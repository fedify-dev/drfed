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

import { getLogger as getQueryLogger } from "@logtape/drizzle-orm";
import { getLogger } from "@logtape/logtape";
import type { Logger } from "drizzle-orm/logger";
/** Suppress parameters for SQL that reads or writes private signing material.
 * @returns A logger that never logs private-key parameters.
 */
export function privateKeySafeLogger(
  delegate: Logger = getQueryLogger(),
): Logger {
  const logger = getLogger(["drfed", "database"]);
  return {
    logQuery(query, params) {
      if (query.toLowerCase().includes("local_actor_keys")) {
        logger.debug("Query: {query}", { query });
      } else delegate.logQuery(query, params);
    },
  };
}
