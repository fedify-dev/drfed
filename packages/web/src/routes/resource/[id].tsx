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

// A resource and its revisions, at /resource/{id}?revision={sequence}.
// Without `revision`, the latest revision the viewer may read is shown.

import { Title } from "@solidjs/meta";
import {
  A,
  type RouteDefinition,
  type RouteSectionProps,
  query,
  useSearchParams,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { ErrorBoundary, Match, Show, Suspense, Switch } from "solid-js";
import {
  createLazyLoadQuery,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";

import { CopyButton } from "~/components/CopyButton.tsx";
import { LoadingIndicator } from "~/components/LoadingIndicator.tsx";
import { ResourceRevision } from "~/components/ResourceRevision.tsx";
import { ResourceTimeline } from "~/components/ResourceTimeline.tsx";
import { WORDING, parseSequence, resourceHref } from "~/resource.ts";

import type { ResourcePageQuery } from "./__generated__/ResourcePageQuery.graphql.ts";
import type { ResourcePageRevisionQuery } from "./__generated__/ResourcePageRevisionQuery.graphql.ts";

import styles from "~/styles/resource.module.css";

const resourcePageQuery = graphql`
  query ResourcePageQuery($id: ID!) @throwOnFieldError {
    node(id: $id) {
      ... on Resource @alias(as: "resource") {
        id
        iri
        kind
        currentRevision {
          sequence
        }
        latest: revisions(first: 1) {
          edges {
            node {
              sequence
            }
          }
        }
        ...ResourceTimeline_resource
      }
    }
  }
`;

const resourcePageRevisionQuery = graphql`
  query ResourcePageRevisionQuery($id: ID!, $sequence: Int!)
  @throwOnFieldError {
    node(id: $id) {
      ... on Resource @alias(as: "resource") {
        revision(sequence: $sequence) {
          ...ResourceRevision_revision
        }
      }
    }
  }
`;

const loadResourcePageQuery = query(
  (id: string) =>
    loadQuery<ResourcePageQuery>(useRelayEnvironment()(), resourcePageQuery, {
      id,
    }),
  "ResourcePageQuery",
);

export const route = {
  preload({ params }) {
    if (params.id === undefined) {
      throw new Error("Missing resource ID route parameter.");
    }
    return loadResourcePageQuery(params.id);
  },
} satisfies RouteDefinition;

type RouteData = ReturnType<typeof loadResourcePageQuery>;

export default function ResourcePage(props: RouteSectionProps<RouteData>) {
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
        <Suspense fallback={<LoadingIndicator label="Loading resource…" />}>
          <ResourceContent data={props.data} />
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

function ResourceContent(props: { data: RouteData }) {
  const data = createPreloadedQuery<ResourcePageQuery>(
    resourcePageQuery,
    () => props.data,
  );
  const [search] = useSearchParams<{ revision?: string }>();
  const parameter = () => search.revision;
  return (
    <Show when={data()}>
      <Show when={data()?.node?.resource} fallback={<p>Resource not found.</p>}>
        {(resource) => {
          const latest = () => resource().latest.edges[0]?.node.sequence;
          // The sequence to show; undefined when the parameter names none.
          const shown = () => {
            const value = parameter();
            return value === undefined ? latest() : parseSequence(value);
          };
          return (
            <>
              <Title>{resource().iri} — DrFed</Title>
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
                <Match when={resource().kind === "unknown"}>
                  <p class={styles.notice}>{WORDING.unknownKind}</p>
                </Match>
                <Match when={latest() === undefined}>
                  <p class={styles.empty}>No revisions to show</p>
                </Match>
                <Match when>
                  <div class={styles.railLayout}>
                    <section class={styles.panel}>
                      <h2>History</h2>
                      <ResourceTimeline
                        $resource={resource()}
                        selected={shown()}
                      />
                    </section>
                    <section class={styles.panel}>
                      <Show
                        when={shown()}
                        fallback={
                          <MissingRevision
                            id={resource().id}
                            parameter={parameter() ?? ""}
                          />
                        }
                      >
                        {(sequence) => (
                          <Suspense
                            fallback={
                              <LoadingIndicator label="Loading revision…" />
                            }
                          >
                            <RevisionPanel
                              id={resource().id}
                              sequence={sequence()}
                              head={resource().currentRevision?.sequence}
                            />
                          </Suspense>
                        )}
                      </Show>
                    </section>
                  </div>
                </Match>
              </Switch>
            </>
          );
        }}
      </Show>
    </Show>
  );
}

/**
 * The note that `revision` names no revision the viewer may read.
 * @returns The heading and note.
 */
function MissingRevision(props: { id: string; parameter: string }) {
  return (
    <>
      <h2>Revision {props.parameter}</h2>
      <p class={styles.notice}>
        {WORDING.missingRevision}{" "}
        <A href={resourceHref(props.id)}>{WORDING.showLatest}</A>
      </p>
    </>
  );
}

/**
 * The revision with a sequence, read on its own so that the timeline keeps
 * its loaded pages while another revision is chosen.
 * @returns The revision, or the note that there is none to read.
 */
function RevisionPanel(props: {
  id: string;
  sequence: number;
  /** The sequence of the current revision, if the viewer may read it. */
  head: number | undefined;
}) {
  const data = createLazyLoadQuery<ResourcePageRevisionQuery>(
    resourcePageRevisionQuery,
    () => ({ id: props.id, sequence: props.sequence }),
  );
  return (
    <Show when={data()}>
      <Show
        when={data()?.node?.resource?.revision}
        fallback={
          <MissingRevision id={props.id} parameter={String(props.sequence)} />
        }
      >
        {(revision) => (
          <ResourceRevision
            $revision={revision()}
            head={props.sequence === props.head}
          />
        )}
      </Show>
    </Show>
  );
}
