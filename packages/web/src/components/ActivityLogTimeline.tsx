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

import { graphql } from "relay-runtime";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { createPaginationFragment } from "solid-relay";

import type { ActivityLogTimeline_instance$key } from "./__generated__/ActivityLogTimeline_instance.graphql.ts";
import { ActivityLogBox } from "./ActivityLogBox.tsx";

import styles from "~/styles/activity-log.module.css";

/**
 * A chronological delivery list that loads older entries when scrolled upward.
 * @returns The shared scrollable activity timeline.
 */
export function ActivityLogTimeline(props: {
  $instance: ActivityLogTimeline_instance$key;
}) {
  const data = createPaginationFragment(
    graphql`
      fragment ActivityLogTimeline_instance on Instance
      @throwOnFieldError
      @argumentDefinitions(
        count: { type: "Int", defaultValue: 20 }
        cursor: { type: "String" }
      )
      @refetchable(queryName: "ActivityLogTimelinePaginationQuery") {
        activityDeliveries(first: $count, after: $cursor)
          @connection(key: "ActivityLogTimeline_activityDeliveries") {
          edges {
            node {
              id
              direction
              ...ActivityLogBox_log
            }
          }
        }
      }
    `,
    () => props.$instance,
  );
  const entries = createMemo(() =>
    (data()?.activityDeliveries.edges ?? []).toReversed(),
  );
  const [failed, setFailed] = createSignal(false);
  let viewport: HTMLElement | undefined;
  let initialized = false;
  let anchor: { height: number } | undefined;
  let frame: number | undefined;

  // Older pages are prepended visually; compensate for their height so the
  // current reading position stays in place, including scrolling during the request.
  createEffect(() => {
    entries();
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!viewport) return;
      if (!initialized) {
        viewport.scrollTop = viewport.scrollHeight;
        initialized = true;
      } else if (anchor) {
        viewport.scrollTop += viewport.scrollHeight - anchor.height;
        anchor = undefined;
      }
    });
  });
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame);
  });

  function loadOlder() {
    if (!viewport || !data.hasNext || data.isLoadingNext) return;
    anchor = { height: viewport.scrollHeight };
    setFailed(false);
    data.loadNext(20, {
      onComplete(error) {
        if (error) {
          anchor = undefined;
          setFailed(true);
        }
      },
    });
  }

  return (
    <div>
      <section
        ref={(element) => {
          viewport = element;
        }}
        aria-label="Activity log history"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        class={styles.timeline}
        onScroll={() => {
          if (initialized && viewport && viewport.scrollTop < 64 && !failed()) {
            loadOlder();
          }
        }}
      >
        <Show when={failed()}>
          <p role="alert">
            Could not load older logs.{" "}
            <button onClick={loadOlder}>Retry</button>
          </p>
        </Show>
        <Show when={data.isLoadingNext}>
          <output>Loading older logs…</output>
        </Show>
        <Show
          when={entries().length > 0}
          fallback={<p>No activity recorded yet.</p>}
        >
          <ul class={styles.list}>
            <For each={entries()}>
              {(edge) => (
                <li class={styles.row}>
                  <div
                    class={[
                      styles.entry,
                      edge.node.direction === "inbound"
                        ? styles.incoming
                        : styles.outgoing,
                    ].join(" ")}
                  >
                    <ActivityLogBox $log={edge.node} />
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </div>
  );
}
