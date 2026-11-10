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
  type Params,
  type RouteDefinition,
  type RouteSectionProps,
  type SearchParams,
  query,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { ErrorBoundary, Match, Show, Suspense, Switch } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";

import { CopyButton } from "~/components/CopyButton.tsx";
import { resourcePath } from "~/components/ResourceLink.tsx";
import { ResourceRevisionList } from "~/components/ResourceRevisionList.tsx";
import { ResourceRevisionView } from "~/components/ResourceRevisionView.tsx";

import type { ResourceDetailQuery } from "./__generated__/ResourceDetailQuery.graphql.ts";

import styles from "~/styles/resource.module.css";

// `selectedRevision` is the revision the `revision` search parameter names.
// It is skipped when there is none, and a malformed ID fails it alone, since
// `node` is nullable.
const resourceDetailQuery = graphql`
  query ResourceDetailQuery(
    $id: ID!
    $revisionId: ID!
    $selectsRevision: Boolean!
  ) @throwOnFieldError {
    node(id: $id) {
      ... on Resource @alias(as: "resource") {
        id
        iri
        kind
        currentRevision {
          id
          ...ResourceRevisionView_revision
        }
        ...ResourceRevisionList_resource
      }
    }
    selectedRevision: node(id: $revisionId)
      @include(if: $selectsRevision)
      @catch(to: NULL) {
      ... on ResourceRevision @alias(as: "revision") {
        id
        resource {
          id
        }
        ...ResourceRevisionView_revision
      }
    }
  }
`;

/**
 * Reads the revision the `revision` search parameter selects.
 * @returns Its Relay global ID, or `undefined` for the current revision.
 */
function selectedRevisionId(search: SearchParams): string | undefined {
  const value = search.revision;
  const id = Array.isArray(value) ? value[0] : value;
  return id === "" ? undefined : id;
}

const loadResourceDetailQuery = query(
  (id: string, revisionId: string | undefined) =>
    loadQuery<ResourceDetailQuery>(
      useRelayEnvironment()(),
      resourceDetailQuery,
      {
        id,
        // Unused when no revision is selected, since the field is skipped.
        revisionId: revisionId ?? "",
        selectsRevision: revisionId !== undefined,
      },
    ),
  "ResourceDetailQuery",
);

/**
 * Loads what a resource page at the given location shows.
 * @returns The preloaded query, shared through the query cache.
 */
function loadResourcePage(params: Params, search: SearchParams) {
  if (params.id === undefined) {
    throw new Error("Missing resource ID route parameter.");
  }
  return loadResourceDetailQuery(params.id, selectedRevisionId(search));
}

export const route = {
  preload: ({ params, location }) => loadResourcePage(params, location.query),
} satisfies RouteDefinition;

type RouteData = ReturnType<typeof loadResourceDetailQuery>;

export default function ResourceDetailPage(
  props: RouteSectionProps<RouteData>,
) {
  // The router runs `preload` once per path, not when only the `revision`
  // search parameter changes, so the page loads its query again, which the
  // query cache answers with what `preload` loaded for the same location.
  const data = () => loadResourcePage(props.params, props.location.query);
  return (
    <main class={styles.page}>
      <Title>Resource — DrFed</Title>
      <A class={styles.backLink} href="/workspace">
        ← All instances
      </A>
      <ErrorBoundary
        fallback={
          <p role="alert">
            Unable to load this resource. Please reload the page to try again.
          </p>
        }
      >
        <Suspense fallback={<output>Loading resource…</output>}>
          <ResourceDetailContent
            data={data()}
            revisionId={selectedRevisionId(props.location.query)}
          />
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

function ResourceDetailContent(props: {
  data: RouteData;
  /** The revision to show instead of the current one. */
  revisionId: string | undefined;
}) {
  const data = createPreloadedQuery<ResourceDetailQuery>(
    resourceDetailQuery,
    () => props.data,
  );
  return (
    <Show when={data()}>
      <Show when={data()?.node?.resource} fallback={<p>Resource not found.</p>}>
        {(resource) => (
          <>
            <header class={styles.header}>
              <p class={styles.label}>
                {resource().kind === "unknown"
                  ? "Unresolved IRI"
                  : resource().kind}
              </p>
              <h1>{resource().iri}</h1>
              <CopyButton value={resource().iri} label="resource IRI" />
            </header>
            <Switch>
              <Match when={resource().currentRevision}>
                {(current) => {
                  // The revision the search parameter names, unless it is
                  // missing, unreadable or another resource's.
                  const selected = () => {
                    const revision = data()?.selectedRevision?.revision;
                    return revision?.resource.id === resource().id
                      ? revision
                      : undefined;
                  };
                  const shown = () =>
                    props.revisionId === undefined ? current() : selected();
                  return (
                    <>
                      <section
                        class={styles.panel}
                        aria-labelledby="revision-title"
                      >
                        {/* Plain anchors, since `A` would mark every link to
                            this page as the current page. */}
                        <Show
                          when={shown()}
                          keyed
                          fallback={
                            <>
                              <h2 id="revision-title">Revision not found</h2>
                              <p class={styles.notice}>
                                This resource has no such revision that you can
                                read.{" "}
                                <a href={resourcePath(resource().id)}>
                                  Show the current revision
                                </a>
                              </p>
                            </>
                          }
                        >
                          {(revision) => (
                            <>
                              <h2 id="revision-title">
                                {revision.id === current().id
                                  ? "Current revision"
                                  : "Earlier revision"}
                              </h2>
                              <Show when={revision.id !== current().id}>
                                <p>
                                  <a href={resourcePath(resource().id)}>
                                    Show the current revision
                                  </a>
                                </p>
                              </Show>
                              <ResourceRevisionView $revision={revision} />
                            </>
                          )}
                        </Show>
                      </section>
                      <section
                        class={styles.panel}
                        aria-labelledby="history-title"
                      >
                        <h2 id="history-title">History</h2>
                        <ResourceRevisionList
                          $resource={resource()}
                          currentId={current().id}
                          shownId={shown()?.id}
                        />
                      </section>
                    </>
                  );
                }}
              </Match>
              <Match when={resource().kind === "unknown"}>
                <p class={styles.notice}>
                  DrFed knows this IRI only as a reference. It holds no details
                  about what the IRI names.
                </p>
              </Match>
              <Match when>
                <p class={styles.notice}>
                  This resource has no revision you can read.
                </p>
              </Match>
            </Switch>
          </>
        )}
      </Show>
    </Show>
  );
}
