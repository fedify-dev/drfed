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

import { A, useSearchParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { ErrorBoundary, For, Show, Suspense } from "solid-js";
import { createLazyLoadQuery } from "solid-relay";

import { resourceHref } from "~/resource.ts";

import type { ActorObjectListQuery } from "./__generated__/ActorObjectListQuery.graphql.ts";
import { CopyButton } from "./CopyButton.tsx";
import { FilterCheckbox, FilterDisclosure } from "./FilterDisclosure.tsx";
import { LoadingIndicator } from "./LoadingIndicator.tsx";

import styles from "~/styles/actor.module.css";

const actorObjectListQuery = graphql`
  query ActorObjectListQuery($id: ID!, $includeDeleted: Boolean!)
  @throwOnFieldError {
    node(id: $id) {
      ... on Actor @alias(as: "actor") {
        objects(first: 20, filter: { includeDeleted: $includeDeleted }) {
          edges {
            node {
              id
              type
              name
              contentHtml
              published
              deleted
              iri
              resource {
                id
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Displays an actor's latest objects with their raw HTML content, and those
 * it deleted when the `deleted` search parameter asks for them.  The
 * parameter is the filter's only state, so the checkbox always matches the
 * list it requested.
 * @returns The object list with its filter.
 */
export function ActorObjectList(props: {
  /** The global ID of the actor whose objects to list. */
  id: string;
}) {
  const [search, setSearch] = useSearchParams<{ deleted?: string }>();
  const includeDeleted = () => search.deleted === "true";
  return (
    <section class={styles.panel} aria-labelledby="objects-title">
      <div class={styles.panelHeader}>
        <h2 id="objects-title">Objects</h2>
        <FilterDisclosure label="objects" active={includeDeleted() ? 1 : 0}>
          <FilterCheckbox
            label="Deleted objects"
            checked={includeDeleted()}
            onChange={(checked) => {
              setSearch(
                { deleted: checked ? "true" : undefined },
                { replace: true },
              );
            }}
          />
        </FilterDisclosure>
      </div>
      <ErrorBoundary
        fallback={(_, reset) => (
          <p class={styles.objectEmpty} role="alert">
            Could not load the objects.{" "}
            <button type="button" onClick={reset}>
              Try again
            </button>
          </p>
        )}
      >
        <Suspense fallback={<LoadingIndicator label="Loading objects…" />}>
          <ObjectItems id={props.id} includeDeleted={includeDeleted()} />
        </Suspense>
      </ErrorBoundary>
    </section>
  );
}

/**
 * The objects that match the filter, read on their own so that the filter
 * stays usable while they load.
 * @returns The object list or its empty state.
 */
function ObjectItems(props: { id: string; includeDeleted: boolean }) {
  const data = createLazyLoadQuery<ActorObjectListQuery>(
    actorObjectListQuery,
    () => ({ id: props.id, includeDeleted: props.includeDeleted }),
  );
  return (
    <Show when={data()?.node?.actor}>
      {(actor) => (
        <Show
          when={actor().objects.edges.length > 0}
          fallback={<p class={styles.objectEmpty}>No objects yet.</p>}
        >
          <ul class={styles.objectList}>
            <For each={actor().objects.edges}>
              {(edge) => (
                <Show when={edge.node}>
                  {(object) => (
                    <li
                      class={
                        object().deleted == undefined
                          ? undefined
                          : styles.deletedObject
                      }
                    >
                      <article>
                        <header class={styles.objectHeader}>
                          <p class={styles.label}>
                            {object().type}
                            <Show when={object().deleted}>
                              {(deleted) => (
                                <span class={styles.deletedLabel}>
                                  {" "}
                                  · Deleted{" "}
                                  <time dateTime={deleted()}>{deleted()}</time>
                                </span>
                              )}
                            </Show>
                          </p>
                          <h3>{object().name ?? "Untitled object"}</h3>
                          <div class={styles.endpoint}>
                            <span class={styles.objectIri}>
                              IRI: {object().iri}
                            </span>
                            <CopyButton
                              value={object().iri}
                              label="object IRI"
                            />
                          </div>
                          <A
                            class={styles.objectHistory}
                            href={resourceHref(object().resource.id)}
                          >
                            Revision history
                          </A>
                          <time dateTime={object().published}>
                            {object().published}
                          </time>
                        </header>
                        <pre class={styles.objectContent}>
                          <code>{object().contentHtml}</code>
                        </pre>
                      </article>
                    </li>
                  )}
                </Show>
              )}
            </For>
          </ul>
        </Show>
      )}
    </Show>
  );
}
