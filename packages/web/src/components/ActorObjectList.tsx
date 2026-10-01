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
import { For, Show } from "solid-js";
import { createFragment } from "solid-relay";

import type { ActorObjectList_actor$key } from "./__generated__/ActorObjectList_actor.graphql.ts";
import { CopyButton } from "./CopyButton.tsx";

import styles from "~/styles/actor.module.css";

/**
 * Displays an actor's latest objects with their raw HTML content.
 * @returns The object list or its empty state.
 */
export function ActorObjectList(props: { $actor: ActorObjectList_actor$key }) {
  const data = createFragment(
    graphql`
      fragment ActorObjectList_actor on Actor @throwOnFieldError {
        objects(first: 20) {
          edges {
            node {
              id
              type
              name
              contentHtml
              published
              iri
            }
          }
        }
      }
    `,
    () => props.$actor,
  );

  return (
    <Show when={data()}>
      {(actor) => (
        <section class={styles.panel} aria-labelledby="objects-title">
          <h2 id="objects-title">Objects</h2>
          <Show
            when={actor().objects.edges.length > 0}
            fallback={<p class={styles.objectEmpty}>No objects yet.</p>}
          >
            <ul class={styles.objectList}>
              <For each={actor().objects.edges}>
                {(edge) => (
                  <Show when={edge.node}>
                    {(object) => (
                      <li>
                        <article>
                          <header class={styles.objectHeader}>
                            <p class={styles.label}>{object().type}</p>
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
