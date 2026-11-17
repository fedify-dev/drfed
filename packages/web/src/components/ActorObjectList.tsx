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
import { For, Show, createSignal } from "solid-js";
import { createRefetchableFragment } from "solid-relay";

import { resourceHref } from "~/resource.ts";

import type { ActorObjectList_actor$key } from "./__generated__/ActorObjectList_actor.graphql.ts";
import type { ActorObjectListRefetchQuery } from "./__generated__/ActorObjectListRefetchQuery.graphql.ts";
import { CopyButton } from "./CopyButton.tsx";
import { FilterCheckbox, FilterDisclosure } from "./FilterDisclosure.tsx";
import { LoadingIndicator } from "./LoadingIndicator.tsx";

import styles from "~/styles/actor.module.css";

/**
 * Displays an actor's latest objects with their raw HTML content, and those
 * it deleted when the filter asks for them.
 * @returns The object list or its empty state.
 */
export function ActorObjectList(props: { $actor: ActorObjectList_actor$key }) {
  const [data, refetch] = createRefetchableFragment<
    ActorObjectListRefetchQuery,
    ActorObjectList_actor$key
  >(
    graphql`
      fragment ActorObjectList_actor on Actor
      @throwOnFieldError
      @argumentDefinitions(
        includeDeleted: { type: "Boolean", defaultValue: false }
      )
      @refetchable(queryName: "ActorObjectListRefetchQuery") {
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
    `,
    () => props.$actor,
  );
  const [includeDeleted, setIncludeDeleted] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  function filterDeleted(checked: boolean) {
    setIncludeDeleted(checked);
    setPending(true);
    setFailed(false);
    refetch(
      { includeDeleted: checked },
      {
        fetchPolicy: "store-and-network",
        onComplete(error) {
          setPending(false);
          setFailed(error != undefined);
        },
      },
    );
  }

  return (
    <Show when={data.latest}>
      {(actor) => (
        <section class={styles.panel} aria-labelledby="objects-title">
          <div class={styles.panelHeader}>
            <h2 id="objects-title">Objects</h2>
            <FilterDisclosure label="objects" active={includeDeleted() ? 1 : 0}>
              <FilterCheckbox
                label="Deleted objects"
                checked={includeDeleted()}
                disabled={pending()}
                onChange={filterDeleted}
              />
            </FilterDisclosure>
          </div>
          <Show when={pending()}>
            <LoadingIndicator label="Loading objects…" />
          </Show>
          <Show when={failed()}>
            <p class={styles.objectEmpty} role="alert">
              Could not load the objects. Change the filter to try again.
            </p>
          </Show>
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
                                    <time dateTime={deleted()}>
                                      {deleted()}
                                    </time>
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
        </section>
      )}
    </Show>
  );
}
