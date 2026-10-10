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
import type { FederationBuilder } from "@fedify/fedify";
import { Activity, Create } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";

import {
  markHandled,
  receipt,
  tracking,
} from "./activity-delivery/tracking.ts";
import { persistCreate } from "./inbox-persist.ts";

const logger = getLogger(["drfed", "federation"]);

/**
 * Registers the personal and shared inbox listeners.  A `Create` that meets
 * the rules for storing it is stored with its actor and object; any other
 * activity is only logged.
 * @param builder The builder to register on.
 * @param db The database to store received activities in.
 */
export function registerInboxListeners(
  builder: FederationBuilder<unknown>,
  db: Database,
): void {
  builder
    .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    .on(Create, async (ctx, activity) => {
      await persistCreate(db, ctx, activity, receipt());
      markHandled();
      logger.debug("Received a Create: {activity}", { activity });
    })
    .on(Activity, (_ctx, activity) => {
      markHandled();
      logger.debug("Received an activity: {activity}", { activity });
    })
    .onRequestFinished((_ctx, report) => {
      const state = tracking();
      if (state != null) state.inboxReport = report;
    })
    .onError((_ctx, error) => {
      logger.error("An error occurred while processing an inbox: {error}", {
        error,
      });
    });
}
