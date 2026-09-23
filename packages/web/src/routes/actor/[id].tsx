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
import { ErrorBoundary, Show, Suspense } from "solid-js";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";

import { ActorDetail } from "~/components/ActorDetail.tsx";

import type { ActorDetailQuery } from "./__generated__/ActorDetailQuery.graphql.ts";

import styles from "~/styles/actor.module.css";

const actorDetailQuery = graphql`
  query ActorDetailQuery($id: ID!) @throwOnFieldError {
    node(id: $id) {
      ... on Actor @alias(as: "actor") {
        ...ActorDetail_actor
      }
    }
  }
`;

const loadActorDetailQuery = query(
  (id: string) =>
    loadQuery<ActorDetailQuery>(useRelayEnvironment()(), actorDetailQuery, {
      id,
    }),
  "ActorDetailQuery",
);

export const route = {
  preload({ params }) {
    if (params.id === undefined) {
      throw new Error("Missing actor ID route parameter.");
    }
    return loadActorDetailQuery(params.id);
  },
} satisfies RouteDefinition;

type RouteData = ReturnType<typeof loadActorDetailQuery>;

export default function ActorDetailPage(props: RouteSectionProps<RouteData>) {
  return (
    <main class={styles.page}>
      <Title>Actor — DrFed</Title>
      <A class={styles.backLink} href="/workspace">
        ← All instances
      </A>
      <ErrorBoundary
        fallback={
          <p role="alert">
            Unable to load this actor. Please reload the page to try again.
          </p>
        }
      >
        <Suspense fallback={<output>Loading actor…</output>}>
          <ActorDetailContent data={props.data} />
        </Suspense>
      </ErrorBoundary>
    </main>
  );
}

function ActorDetailContent(props: { data: RouteData }) {
  const data = createPreloadedQuery<ActorDetailQuery>(
    actorDetailQuery,
    () => props.data,
  );
  const actor = () => {
    const node = data()?.node;
    return node?.actor;
  };
  return (
    <Show when={data()}>
      <Show when={actor()} fallback={<p>Actor not found.</p>}>
        {(value) => <ActorDetail $actor={value()} />}
      </Show>
    </Show>
  );
}
