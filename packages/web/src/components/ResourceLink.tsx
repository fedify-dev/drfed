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

import { A } from "@solidjs/router";
import type { JSX } from "solid-js";

/**
 * The path of the page of a stored resource, which shows its current
 * revision or the one given.
 * @param id The Relay global ID of the `Resource`.
 * @param revision The Relay global ID of a `ResourceRevision` of it.
 * @returns The path, with the revision as its `revision` search parameter.
 */
export const resourcePath = (id: string, revision?: string): string =>
  `/resource/${encodeURIComponent(id)}${
    revision === undefined ? "" : `?revision=${encodeURIComponent(revision)}`
  }`;

/**
 * Links to the page of a stored resource, which shows its revisions.
 * @returns A link to the resource page.
 */
export function ResourceLink(props: {
  /** The Relay global ID of the `Resource`. */
  id: string;
  /**
   * The Relay global ID of the `ResourceRevision` to show; the current one
   * when omitted.
   */
  revision?: string | undefined;
  children: JSX.Element;
}) {
  return <A href={resourcePath(props.id, props.revision)}>{props.children}</A>;
}
