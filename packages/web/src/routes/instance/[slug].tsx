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

import { ActorDetail } from "~/components/ActorDetail.tsx";

import type { InstanceDetailQuery } from "./__generated__/InstanceDetailQuery.graphql.ts";

import styles from "~/styles/instance.module.css";

// Temp Query to show first 100.
const instanceDetailQuery = graphql`
  query InstanceDetailQuery($slug: String!) {
    localInstanceBySlug(slug: $slug) {
      instance {
        id
        host
        actors(first: 100) {
          totalCount
          edges {
            node {
              ...ActorDetail_actor
            }
          }
        }
      }
    }
  }
`;

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
              <div>
                <dt>NodeInfo</dt>
                <dd>
                  <a href={`https://${instance().host}/nodeinfo/2.1`}>
                    {`https://${instance().host}/nodeinfo/2.1`}
                  </a>
                </dd>
              </div>
              <div>
                <dt>WebFinger</dt>
                <dd>
                  <a href={`https://${instance().host}/.well-known/webfinger`}>
                    {`https://${instance().host}/.well-known/webfinger`}
                  </a>
                </dd>
              </div>
              <div>
                <dt>Shared inbox</dt>
                <dd>
                  <a
                    href={`https://${instance().host}/inbox`}
                  >{`https://${instance().host}/inbox`}</a>
                </dd>
              </div>
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
                {(edge) => <ActorDetail $actor={edge.node} />}
              </For>
            </div>
          </section>
        </main>
      )}
    </Show>
  );
}
