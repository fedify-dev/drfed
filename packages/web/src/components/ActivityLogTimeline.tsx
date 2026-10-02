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
        activityLogs(first: $count, after: $cursor)
          @connection(key: "ActivityLogTimeline_activityLogs") {
          edges {
            node {
              id
              direction
              type
              remoteActorIri
              remoteHost
              status
              created
            }
          }
        }
      }
    `,
    () => props.$instance,
  );
  const entries = createMemo(() =>
    (data()?.activityLogs.edges ?? []).toReversed(),
  );
  const [failed, setFailed] = createSignal(false);
  let viewport: HTMLElement | undefined;
  let initialized = false;
  let anchor: { height: number; top: number } | undefined;
  let frame: number | undefined;

  // Older pages are prepended visually; compensate for their height so the
  // entry the reader was looking at stays in place.
  createEffect(() => {
    entries();
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!viewport) return;
      if (!initialized) {
        viewport.scrollTop = viewport.scrollHeight;
        initialized = true;
      } else if (anchor) {
        viewport.scrollTop = anchor.top + viewport.scrollHeight - anchor.height;
        anchor = undefined;
      }
    });
  });
  onCleanup(() => {
    if (frame !== undefined) cancelAnimationFrame(frame);
  });

  function loadOlder() {
    if (!viewport || !data.hasNext || data.isLoadingNext) return;
    anchor = { height: viewport.scrollHeight, top: viewport.scrollTop };
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
        // Keyboard users must be able to focus and scroll this region.
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        style={{
          height: "24rem",
          overflow: "auto",
          "overflow-anchor": "none",
          "overflow-wrap": "anywhere",
        }}
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
          <ul
            style={{
              margin: "0",
              padding: "0",
              "list-style": "none",
              display: "grid",
              gap: "0.75rem",
            }}
          >
            <For each={entries()}>
              {(edge) => (
                <li
                  style={{
                    display: "grid",
                    "grid-template-columns": "minmax(0, 1fr) minmax(0, 1fr)",
                    gap: "1rem",
                  }}
                >
                  <article
                    aria-label={
                      edge.node.direction === "inbound"
                        ? "Incoming activity"
                        : "Outgoing activity"
                    }
                    style={{
                      "grid-column":
                        edge.node.direction === "inbound" ? "1" : "2",
                      border: "1px solid var(--line)",
                      "border-radius": "0.5rem",
                      padding: "0.75rem",
                    }}
                  >
                    <p>
                      <strong>{edge.node.type ?? "Unknown activity"}</strong> ·{" "}
                      {edge.node.status}
                    </p>
                    <p>
                      {edge.node.remoteActorIri ??
                        edge.node.remoteHost ??
                        "Unknown remote actor"}
                    </p>
                    <time dateTime={edge.node.created}>
                      {edge.node.created}
                    </time>
                  </article>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </div>
  );
}
