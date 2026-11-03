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

import { env } from "node:process";

import { configurationBoolean } from "./configuration.ts";

/**
 * The marker the official container image sets.  It is not a setting: it only
 * changes listen defaults, so every CLI, environment and TOML value still wins.
 */
export const containerMarker = "DRFED_CONTAINER";

/**
 * Choose the default listen host without reading any setting source.
 * @param lookup Reads an environment variable; defaults to the process.
 * @returns `0.0.0.0` inside the official container image, else `localhost`.
 */
export function defaultListenHost(
  lookup: (name: string) => string | undefined = (name) => env[name],
): "0.0.0.0" | "localhost" {
  const marker = lookup(containerMarker);
  if (marker === undefined) return "localhost";
  const parsed = configurationBoolean().parse(marker);
  return parsed.success && parsed.value ? "0.0.0.0" : "localhost";
}
