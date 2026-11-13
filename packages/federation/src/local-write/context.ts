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

import type { FieldPath, JsonValue } from "@drfed/models/document";

import { valueAt } from "../document/interpret.ts";

const ACTIVITY_STREAMS = "https://www.w3.org/ns/activitystreams";

/**
 * Keys a path for maps and token allocations.
 * @returns The path's JSON.
 */
export function pathKey(path: FieldPath): string {
  return JSON.stringify(path);
}

/**
 * Lists the entries of a `@context` value, a list or one context.
 * @returns The entries; none for a missing value.
 */
export function contextEntries(value: JsonValue | undefined): JsonValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value];
}

/**
 * Reads the context a document embedded at a path is read with: the
 * contexts of the documents along the path, its own last, after the
 * ActivityStreams context the validator assumes when the root states none.
 * @param document The root document.
 * @param nodePaths The keys of the paths of the documents it describes, as
 *                  {@link pathKey} spells them; other values on the path,
 *                  such as plain JSON objects, state no context.
 * @param path The embedded document's path; `[]` for the root.
 * @returns The context entries, in order.
 */
export function effectiveContext(
  document: JsonValue,
  nodePaths: ReadonlySet<string>,
  path: FieldPath,
): JsonValue[] {
  const chain: JsonValue[] = [];
  for (let length = 0; length <= path.length; length += 1) {
    const prefix = path.slice(0, length);
    if (!nodePaths.has(pathKey(prefix))) continue;
    chain.push(...contextEntries(valueAt(document, [...prefix, "@context"])));
  }
  // The validator reads a document without a context as ActivityStreams.
  if (valueAt(document, ["@context"]) === undefined) {
    chain.unshift(ACTIVITY_STREAMS);
  }
  return chain;
}
