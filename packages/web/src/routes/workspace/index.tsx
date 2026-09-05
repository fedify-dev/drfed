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

import { Link } from "@kobalte/core/link";
import { Title } from "@solidjs/meta";
import { graphql } from "relay-runtime";
import { For, Show } from "solid-js";
import { createLazyLoadQuery } from "solid-relay";

import InstanceSummary from "~/components/InstanceSummary.tsx";

import type { WorkspaceQuery } from "./__generated__/WorkspaceQuery.graphql.tsx";

import styles from "~/styles/workspace.module.css";

const workspaceQuery = graphql`
  query WorkspaceQuery {
    viewer {
      instances(first: 100) {
        edges {
          node {
            ...InstanceSummary_instance
          }
        }
      }
    }
  }
`;

export default function WorkspacePage() {
  const query = createLazyLoadQuery<WorkspaceQuery>(
    workspaceQuery,
    {},
    { fetchPolicy: "store-and-network" },
  );

  return (
    <main class={styles.page}>
      <Title>Workspace — DrFed</Title>

      <header class={styles.header}>
        <h1>Your instances</h1>
        <Show when={query()?.viewer}>
          <Link class={styles.createButton} href="/workspace/create/instance">
            <span aria-hidden="true">+</span>
            New instance
          </Link>
        </Show>
      </header>

      <Show
        when={query()?.viewer}
        fallback={
          <section class={styles.emptyState} aria-labelledby="signed-out-title">
            <p class={styles.emptyLabel}>Workspace unavailable</p>
            <h2 id="signed-out-title">Sign in to manage your instances</h2>
            <p>Your workspace is linked to your DrFed account.</p>
            <Link class={styles.secondaryButton} href="/sign-in">
              Sign in
            </Link>
          </section>
        }
      >
        {(viewer) => (
          <Show
            when={viewer().instances.edges.length > 0}
            fallback={
              <section
                class={styles.emptyState}
                aria-labelledby="empty-workspace-title"
              >
                <p class={styles.emptyLabel}>No instances yet</p>
                <h2 id="empty-workspace-title">Build your first test server</h2>
                <p>
                  Start with an instance, then add actors to explore federation
                  flows.
                </p>
                <Link
                  class={styles.secondaryButton}
                  href="/workspace/create/instance"
                >
                  Create an instance
                </Link>
              </section>
            }
          >
            <section class={styles.instanceList} aria-label="Instances">
              <For each={viewer().instances.edges}>
                {(edge) => <InstanceSummary $instance={edge.node} />}
              </For>
            </section>
          </Show>
        )}
      </Show>
    </main>
  );
}
