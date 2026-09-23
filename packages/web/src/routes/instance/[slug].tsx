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

import { Title } from "@solidjs/meta";
import {
  A,
  type RouteDefinition,
  type RouteSectionProps,
  query,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";

import { ActorCard } from "~/components/ActorCard.tsx";

import type { InstanceDetailQuery } from "./__generated__/InstanceDetailQuery.graphql.ts";

import styles from "~/styles/instance.module.css";

// Temp Query to show first 100.
const instanceDetailQuery = graphql`
  query InstanceDetailQuery($slug: String!) {
    localInstanceBySlug(slug: $slug) {
      instance {
        id
        host
        url
        actors(first: 100) {
          totalCount
          edges {
            node {
              ...ActorCard_actor
            }
          }
        }
      }
    }
  }
`;

/**
 * The federation endpoints worth linking to from an instance's page.
 *
 * Built from the origin the server reports rather than from the host name
 * alone, so that a development instance links to the port it is actually
 * served on instead of an `https:` URL that answers nowhere.
 * @param origin The instance's absolute origin.
 * @returns The endpoints, in the order they are shown.
 */
function endpoints(origin: string): { label: string; url: string }[] {
  return [
    { label: "NodeInfo", url: `${origin}/nodeinfo/2.1` },
    { label: "WebFinger", url: `${origin}/.well-known/webfinger` },
    { label: "Shared inbox", url: `${origin}/inbox` },
  ];
}

const loadInstanceDetailQuery = query(
  (slug: string) =>
    loadQuery<InstanceDetailQuery>(
      useRelayEnvironment()(),
      instanceDetailQuery,
      { slug },
    ),
  "InstanceDetailQuery",
);

export const route = {
  preload({ params }) {
    if (params.slug === undefined) {
      throw new Error("Missing slug route parameter.");
    }

    return loadInstanceDetailQuery(params.slug);
  },
} satisfies RouteDefinition;

type RouteData = ReturnType<typeof loadInstanceDetailQuery>;

export default function InstanceDetailPage(
  props: RouteSectionProps<RouteData>,
) {
  const data = createPreloadedQuery<InstanceDetailQuery>(
    instanceDetailQuery,
    () => props.data,
  );

  const instanceData = () => data()?.localInstanceBySlug?.instance;

  return (
    <Show
      when={instanceData()}
      fallback={
        <main class={styles.page}>
          <A class={styles.backLink} href="/workspace">
            <span aria-hidden="true">←</span> All instances
          </A>
          <p>Instance not found.</p>
        </main>
      }
    >
      {(instance) => (
        <main class={styles.page}>
          <Title>{instance().host} — DrFed</Title>

          <A class={styles.backLink} href="/workspace">
            <span aria-hidden="true">←</span> All instances
          </A>

          <header class={styles.header}>
            <h1>{instance().host}</h1>
            <A
              class={styles.createButton}
              href={`/workspace/create/${instance().id}/actors`}
            >
              <span aria-hidden="true">＋</span>
              Create actor
            </A>
          </header>

          <section class={styles.details} aria-labelledby="connection-title">
            <div>
              <p class={styles.sectionLabel}>Connection record</p>
              <h2 id="connection-title">Federation endpoints</h2>
            </div>
            <dl class={styles.endpointList}>
              <For each={endpoints(instance().url)}>
                {({ label, url }) => (
                  <div>
                    <dt>{label}</dt>
                    <dd>
                      <a href={url}>{url}</a>
                    </dd>
                  </div>
                )}
              </For>
            </dl>
          </section>

          <section class={styles.actors} aria-labelledby="actors-title">
            <header class={styles.sectionHeader}>
              <div>
                <p class={styles.sectionLabel}>Local identities</p>
                <h2 id="actors-title">Actors</h2>
              </div>
              <p>{instance().actors.totalCount} registered</p>
            </header>
            <div class={styles.actorList}>
              <For each={instance().actors.edges}>
                {(edge) => <ActorCard $actor={edge.node} />}
              </For>
            </div>
          </section>
        </main>
      )}
    </Show>
  );
}
