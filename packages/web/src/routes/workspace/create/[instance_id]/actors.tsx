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

import { Button } from "@kobalte/core/button";
import { NumberField } from "@kobalte/core/number-field";
import { Title } from "@solidjs/meta";
import {
  type RouteDefinition,
  type RouteSectionProps,
  query,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import {
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";

import type { GetHostQuery } from "./__generated__/GetHostQuery.graphql";

import styles from "~/styles/form.module.css";

const getHostQuery = graphql`
  query GetHostQuery($instanceId: ID!) {
    instance: node(id: $instanceId) {
      ... on Instance {
        host
      }
    }
  }
`;

const loadInstanceQuery = query(
  (instanceId: string) =>
    loadQuery<GetHostQuery>(useRelayEnvironment()(), getHostQuery, {
      instanceId,
    }),
  "GetHostQuery",
);

export const route = {
  preload({ params }) {
    if (params.instance_id === undefined) {
      throw new Error("Missing instance_id route parameter.");
    }
    return loadInstanceQuery(params.instance_id);
  },
} satisfies RouteDefinition;

type RouteData = ReturnType<typeof loadInstanceQuery>;

export default function CreateActorsPage(props: RouteSectionProps<RouteData>) {
  const data = createPreloadedQuery<GetHostQuery>(
    getHostQuery,
    () => props.data,
  );

  return (
    <main class={styles.page}>
      <Title>Create Actors</Title>
      <NumberField></NumberField>
      <section class={styles.panel} aria-labelledby="create-actors-title">
        <header class={styles.header}>
          <h1 id="create-actors-title">Create Actors</h1>
          <p>Selected Instance: {data()?.instance?.host}</p>
        </header>
        <form class={styles.form}>
          <NumberField class={styles.field} name="actors" minValue={1}>
            <NumberField.Label>The Number of Actors</NumberField.Label>
            <NumberField.Input class={styles.input} placeholder="5" required />
            <NumberField.Description class={styles.hint}>
              DrFed generates actors in {data()?.instance?.host}.
            </NumberField.Description>
          </NumberField>

          <Button class={styles.button} type="submit">
            Create Actors
          </Button>
        </form>
      </section>
    </main>
  );
}
