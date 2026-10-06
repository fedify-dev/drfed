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

import type { FederationBuilder } from "@fedify/fedify";
import { Activity } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";

import { markHandled } from "./activity-delivery/tracking.ts";

const logger = getLogger(["drfed", "federation"]);

/**
 * Registers the personal and shared inbox listeners.
 * @param builder The builder to register on.
 */
export function registerInboxListeners(
  builder: FederationBuilder<unknown>,
): void {
  builder
    .setInboxListeners("/users/{identifier}/inbox", "/inbox")
    // FIXME: https://github.com/fedify-dev/drfed/issues/88
    .on(Activity, (_ctx, activity) => {
      markHandled();
      logger.debug("Received an activity: {activity}", { activity });
    })
    .onError((_ctx, error) => {
      logger.error("An error occurred while processing an inbox: {error}", {
        error,
      });
    });
}
