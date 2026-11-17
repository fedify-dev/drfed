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
import { graphql } from "relay-runtime";
import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { createPaginationFragment } from "solid-relay";

import { WORDING, resourceHref, timelineEntries } from "~/resource.ts";

import type { ResourceTimeline_resource$key } from "./__generated__/ResourceTimeline_resource.graphql.ts";
import { LoadingIndicator } from "./LoadingIndicator.tsx";
import { TimeText } from "./ResourceRevision.tsx";

import styles from "~/styles/resource.module.css";

const PAGE_SIZE = 20;

/**
 * The history of a resource as a vertical timeline, newest first, with the
 * revisions the viewer may not read counted between them.
 * @returns The timeline.
 */
export function ResourceTimeline(props: {
  $resource: ResourceTimeline_resource$key;
  /** The sequence of the revision shown beside it. */
  selected: number | undefined;
}) {
  const data = createPaginationFragment(
    graphql`
      fragment ResourceTimeline_resource on Resource
      @throwOnFieldError
      @argumentDefinitions(
        count: { type: "Int", defaultValue: 20 }
        cursor: { type: "String" }
      )
      @refetchable(queryName: "ResourceTimelinePaginationQuery") {
        id
        currentRevision {
          sequence
        }
        revisions(first: $count, after: $cursor)
          @connection(key: "ResourceTimeline_revisions") {
          edges {
            node {
              id
              sequence
              kind
              capture
              backfilled
              created
            }
          }
        }
      }
    `,
    () => props.$resource,
  );
  const [failed, setFailed] = createSignal(false);
  const entries = createMemo(() =>
    timelineEntries(
      (data()?.revisions.edges ?? []).map((edge) => edge.node),
      data()?.currentRevision?.sequence,
      !data.hasNext,
    ),
  );
  function loadOlder() {
    if (!data.hasNext || data.isLoadingNext) return;
    setFailed(false);
    data.loadNext(PAGE_SIZE, {
      onComplete(error) {
        if (error) setFailed(true);
      },
    });
  }
  return (
    <Show when={data()}>
      {(resource) => (
        <div>
          {/* Safari drops list semantics without list markers. */}
          {/* oxlint-disable-next-line jsx-a11y/no-redundant-roles */}
          <ol class={styles.timeline} role="list">
            <For each={entries()}>
              {(entry) => (
                <Switch>
                  <Match when={entry.type === "head-unreadable"}>
                    <li class={styles.gapEntry}>{WORDING.headUnreadable}</li>
                  </Match>
                  <Match when={entry.type === "gap" ? entry : undefined}>
                    {(gap) => (
                      <li class={styles.gapEntry}>
                        {WORDING.gap(gap().count)}
                      </li>
                    )}
                  </Match>
                  <Match when={entry.type === "revision" ? entry : undefined}>
                    {(item) => (
                      <li
                        class={[
                          styles.revisionEntry,
                          item().revision.sequence === props.selected
                            ? styles.selectedEntry
                            : "",
                          item().revision.kind === "whiteout"
                            ? styles.whiteoutEntry
                            : "",
                        ].join(" ")}
                      >
                        <span class={styles.entryLine}>
                          <A
                            class={styles.entrySequence}
                            href={resourceHref(
                              resource().id,
                              item().revision.sequence,
                            )}
                            aria-current={
                              item().revision.sequence === props.selected
                                ? "true"
                                : undefined
                            }
                          >
                            #{item().revision.sequence}
                          </A>
                          <span>{item().revision.kind}</span>
                          <Show when={item().head}>
                            <span class={styles.pill}>Current</span>
                          </Show>
                        </span>
                        <span class={styles.entryDetail}>
                          {item().revision.capture}
                          {item().revision.backfilled ? " · backfilled" : ""}
                        </span>
                        <span class={styles.entryDetail}>
                          <TimeText value={item().revision.created} />
                        </span>
                      </li>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </ol>
          <Show when={failed()}>
            <p role="alert">
              Could not load older revisions.{" "}
              <button type="button" class={styles.loadMore} onClick={loadOlder}>
                Retry
              </button>
            </p>
          </Show>
          <Show when={data.isLoadingNext}>
            <LoadingIndicator label="Loading older revisions…" />
          </Show>
          <Show when={data.hasNext && !data.isLoadingNext && !failed()}>
            <button type="button" class={styles.loadMore} onClick={loadOlder}>
              Load older revisions
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}
