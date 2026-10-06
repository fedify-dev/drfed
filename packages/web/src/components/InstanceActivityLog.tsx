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

import { ErrorBoundary } from "solid-js";

import type { ActivityLogTimeline_instance$key } from "./__generated__/ActivityLogTimeline_instance.graphql.ts";
import { ActivityLogTimeline } from "./ActivityLogTimeline.tsx";

/**
 * Displays the instance's incoming and outgoing delivery logs.
 * @returns The activity log section with a shared chronological timeline.
 */
export function InstanceActivityLog(props: {
  $instance: ActivityLogTimeline_instance$key;
}) {
  return (
    <section aria-labelledby="activity-log-title">
      <h2 id="activity-log-title">Activity log</h2>
      <ErrorBoundary
        fallback={
          <p>
            Activity logs could not be loaded. Access requires instance
            membership or administrator permissions.
          </p>
        }
      >
        <ActivityLogTimeline $instance={props.$instance} />
      </ErrorBoundary>
    </section>
  );
}
