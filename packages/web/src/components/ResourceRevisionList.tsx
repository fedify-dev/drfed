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
import { For, Show, createSignal } from "solid-js";
import { createPaginationFragment } from "solid-relay";

import type { ResourceRevisionList_resource$key } from "./__generated__/ResourceRevisionList_resource.graphql.ts";
import { resourcePath } from "./ResourceLink.tsx";

import styles from "~/styles/resource.module.css";

/**
 * Lists the revisions of a resource, newest first, loading older ones on
 * request.  Each opens on the resource page; the current one without a
 * `revision` search parameter.
 * @returns The revision table, or a note when there is none to read.
 */
export function ResourceRevisionList(props: {
  $resource: ResourceRevisionList_resource$key;
  /** The ID of the current revision, which is marked. */
  currentId: string;
  /** The ID of the revision the page shows, which is marked; none if any. */
  shownId: string | undefined;
}) {
  const data = createPaginationFragment(
    graphql`
      fragment ResourceRevisionList_resource on Resource
      @throwOnFieldError
      @argumentDefinitions(
        count: { type: "Int", defaultValue: 20 }
        cursor: { type: "String" }
      )
      @refetchable(queryName: "ResourceRevisionListPaginationQuery") {
        id
        revisions(first: $count, after: $cursor)
          @connection(key: "ResourceRevisionList_revisions") {
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

  function loadOlder() {
    if (!data.hasNext || data.isLoadingNext) return;
    setFailed(false);
    data.loadNext(20, {
      onComplete(error) {
        if (error) setFailed(true);
      },
    });
  }

  return (
    <Show when={data()}>
      {(resource) => (
        <Show
          when={resource().revisions.edges.length > 0}
          fallback={
            <p class={styles.empty}>
              This resource has no revision you can read.
            </p>
          }
        >
          <table class={styles.history}>
            <thead>
              <tr>
                <th scope="col">Sequence</th>
                <th scope="col">Kind</th>
                <th scope="col">Capture</th>
                <th scope="col">Stored</th>
              </tr>
            </thead>
            <tbody>
              <For each={resource().revisions.edges}>
                {({ node: revision }) => (
                  <tr
                    class={
                      revision.id === props.shownId ? styles.shown : undefined
                    }
                  >
                    <td>
                      {/* A plain anchor, since `A` would mark every revision
                          of this page as the current page. */}
                      <a
                        href={resourcePath(
                          resource().id,
                          revision.id === props.currentId
                            ? undefined
                            : revision.id,
                        )}
                        aria-current={
                          revision.id === props.shownId ? "true" : undefined
                        }
                      >
                        {revision.sequence}
                      </a>
                      <Show when={revision.id === props.currentId}>
                        {" "}
                        <span class={styles.badge}>Current</span>
                      </Show>
                      <Show when={revision.id === props.shownId}>
                        {" "}
                        <span class={styles.badgeStrong}>Shown</span>
                      </Show>
                    </td>
                    <td>{revision.kind}</td>
                    <td>
                      {revision.capture}
                      {revision.backfilled ? " (backfilled)" : ""}
                    </td>
                    <td>
                      <time dateTime={revision.created}>
                        {revision.created}
                      </time>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <Show when={failed()}>
            <p role="alert">Could not load older revisions.</p>
          </Show>
          <Show when={data.hasNext}>
            <button
              type="button"
              class={styles.loadMore}
              disabled={data.isLoadingNext}
              onClick={loadOlder}
            >
              {data.isLoadingNext
                ? "Loading older revisions…"
                : `${failed() ? "Retry loading" : "Load"} older revisions`}
            </button>
          </Show>
        </Show>
      )}
    </Show>
  );
}
