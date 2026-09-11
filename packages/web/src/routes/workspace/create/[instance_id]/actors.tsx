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

import { Field, Form, type SubmitHandler, createForm } from "@formisch/solid";
import { Button } from "@kobalte/core/button";
import { NumberField } from "@kobalte/core/number-field";
import { Title } from "@solidjs/meta";
import {
  type RouteDefinition,
  type RouteSectionProps,
  query,
  useNavigate,
} from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show, createSignal } from "solid-js";
import {
  createMutation,
  createPreloadedQuery,
  loadQuery,
  useRelayEnvironment,
} from "solid-relay";
import * as v from "valibot";

import type { GenerateActorsMutation } from "./__generated__/GenerateActorsMutation.graphql.ts";
import type { GetHostQuery } from "./__generated__/GetHostQuery.graphql.ts";

import styles from "~/styles/form.module.css";

const getHostQuery = graphql`
  query GetHostQuery($instanceId: ID!) {
    instance: node(id: $instanceId) {
      ... on Instance {
        id
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

const generateActorsMutation = graphql`
  mutation GenerateActorsMutation($instance: ID!, $size: Int!) {
    generateActors(instance: $instance, size: $size) {
      resultType: __typename
      ... on CreateActorsSuccess {
        actors {
          id
          uuid
          username
          handle
          iri
        }
      }
      ... on CreateActorsError {
        type
        message
      }
    }
  }
`;
const generateActorsSchema = v.object({
  size: v.pipe(
    v.number("Enter the number of actors."),
    v.integer("The number of actors must be a whole number."),
    v.minValue(1, "Create at least one actor."),
  ),
});

export default function CreateActorsPage(props: RouteSectionProps<RouteData>) {
  const [errorMessage, setErrorMessage] = createSignal<string>();
  const [commitGenerateActors, isGeneratingActors] =
    createMutation<GenerateActorsMutation>(generateActorsMutation);
  const navigate = useNavigate();

  const data = createPreloadedQuery<GetHostQuery>(
    getHostQuery,
    () => props.data,
  );

  const generateActorsForm = createForm({
    schema: generateActorsSchema,
    initialInput: {
      size: 1,
    },
  });

  const submit: SubmitHandler<typeof generateActorsSchema> = ({ size }) => {
    const instance = data()?.instance?.id;

    if (instance === undefined) {
      setErrorMessage("Instance not found.");
      return;
    }
    setErrorMessage(undefined);
    commitGenerateActors({
      variables: { instance, size },
      onCompleted: (response, errors) => {
        const graphQLErrors = errors ?? [];
        if (graphQLErrors.length > 0) {
          setErrorMessage(
            graphQLErrors.map((error) => error.message).join("\n"),
          );
          return;
        }

        const result = response.generateActors;
        switch (result.resultType) {
          case "CreateActorsSuccess": {
            navigate(-1);
            return;
          }
          case "CreateActorsError": {
            switch (result.type) {
              case "InvalidSize": {
                setErrorMessage("Enter at least one actor.");
                return;
              }
              case "InstanceNotFound": {
                setErrorMessage(
                  "The selected instance could not be found or is no longer available.",
                );
                return;
              }
              case "TooManyActors": {
                setErrorMessage(result.message);
                return;
              }
              case "%future added value": {
                setErrorMessage(
                  "The server returned an unsupported actor-generation error.",
                );
                return;
              }
              default: {
                setErrorMessage("Unable to generate actors.");
                return;
              }
            }
          }
          case "%other": {
            setErrorMessage("Unable to generate actors.");
            return;
          }
          default: {
            setErrorMessage("Unable to generate actors.");
          }
        }
      },
      onError: (error) => {
        setErrorMessage(error.message);
      },
    });
  };

  return (
    <main class={styles.page}>
      <Title>Create Actors</Title>
      <section class={styles.panel} aria-labelledby="create-actors-title">
        <header class={styles.header}>
          <h1 id="create-actors-title">Create Actors</h1>
          <p>Selected Instance: {data()?.instance?.host}</p>
        </header>
        <Form class={styles.form} of={generateActorsForm} onSubmit={submit}>
          <Field of={generateActorsForm} path={["size"]}>
            {(field) => (
              <NumberField
                class={styles.field}
                name={field.props.name}
                value={field.input ?? ""}
                minValue={1}
                onRawValueChange={field.onInput}
              >
                <NumberField.Label class={styles.field}>Size</NumberField.Label>
                <NumberField.Input
                  ref={field.props.ref}
                  onFocus={field.props.onFocus}
                  onBlur={field.props.onBlur}
                  class={styles.input}
                  aria-invalid={Boolean(field.errors)}
                />
                <NumberField.Description class={styles.hint}>
                  DrFed generates actors in {data()?.instance?.host}
                </NumberField.Description>
                <Show when={field.errors}>
                  {(errors) => (
                    <span
                      class={`${styles.notice} ${styles.error}`}
                      role="alert"
                    >
                      {errors()[0]}
                    </span>
                  )}
                </Show>
              </NumberField>
            )}
          </Field>
          <Button
            class={styles.button}
            type="submit"
            disabled={
              isGeneratingActors() || data()?.instance?.id === undefined
            }
          >
            Create Actors
          </Button>
        </Form>
        <Show when={errorMessage()}>
          <p class={`${styles.notice} ${styles.error}`} role="alert">
            {errorMessage()}
          </p>
        </Show>
      </section>
    </main>
  );
}
