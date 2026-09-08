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

import { faker } from "@faker-js/faker";
import { Field, Form, type SubmitHandler, createForm } from "@formisch/solid";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { Title } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show, createSignal } from "solid-js";
import { createMutation } from "solid-relay";
import * as v from "valibot";

import type { CreateInstanceMutation } from "./__generated__/CreateInstanceMutation.graphql.ts";

import styles from "~/styles/form.module.css";

const createInstanceMutation = graphql`
  mutation CreateInstanceMutation($slug: String!) {
    createInstance(slug: $slug) {
      resultType: __typename
      ... on Instance {
        id
      }
      ... on CreateInstanceError {
        message
      }
    }
  }
`;

const createInstanceSchema = v.object({
  slug: v.pipe(
    v.string(),
    v.trim(),
    v.minLength(4, "The slug must contain at least 4 characters."),
    v.maxLength(63, "The slug must contain at most 63 characters."),
    v.regex(
      /^[a-z0-9-]+$/u,
      "The slug can contain only lowercase letters, numbers, and hyphens.",
    ),
  ),
});

const generateSlugWord = () => faker.word.noun({ length: { min: 1, max: 20 } });

export default function CreateInstancePage() {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = createSignal<string>();
  const [commitCreateInstance, isCreatingInstance] =
    createMutation<CreateInstanceMutation>(createInstanceMutation);

  const createInstanceForm = createForm({
    schema: createInstanceSchema,
    initialInput: {
      slug: [generateSlugWord(), generateSlugWord(), generateSlugWord()]
        .join("-")
        .toLowerCase(),
    },
  });

  const submit: SubmitHandler<typeof createInstanceSchema> = ({ slug }) => {
    setErrorMessage(undefined);
    commitCreateInstance({
      variables: { slug },
      onCompleted: (response, errors) => {
        const graphQLErrors = errors ?? [];
        if (graphQLErrors.length > 0) {
          setErrorMessage(
            graphQLErrors.map((error) => error.message).join("\n"),
          );
          return;
        }

        switch (response.createInstance.resultType) {
          case "CreateInstanceError": {
            setErrorMessage(response.createInstance.message);
            return;
          }
          case "Instance": {
            navigate("/workspace/");
            return;
          }
          case "%other": {
            setErrorMessage("Unable to create the instance.");
            return;
          }
          default: {
            setErrorMessage("Unable to create the instance.");
          }
        }
      },
      onError: (error) => {
        setErrorMessage(error.message);
      },
    });
  };

  const buttonLabel = () => {
    if (isCreatingInstance()) {
      return "Creating instance…";
    }
    return "Create instance";
  };

  return (
    <main class={styles.page}>
      <Title>Create an instance — DrFed</Title>

      <section class={styles.panel} aria-labelledby="create-instance-title">
        <header class={styles.header}>
          <h1 id="create-instance-title">Create an instance</h1>
          <p>Review the generated identifier for your new instance.</p>
        </header>

        <Form class={styles.form} of={createInstanceForm} onSubmit={submit}>
          <Field of={createInstanceForm} path={["slug"]}>
            {(field) => (
              <TextField
                class={styles.field}
                name={field.props.name}
                value={field.input ?? ""}
                readOnly
              >
                <TextField.Label class={styles.fieldHeading}>
                  Slug
                  <span class={styles.fieldStatus}>Generated · Read only</span>
                </TextField.Label>

                <TextField.Input
                  {...field.props}
                  class={styles.input}
                  aria-invalid={Boolean(field.errors)}
                  aria-describedby={
                    field.errors ? "slug-hint slug-error" : "slug-hint"
                  }
                />

                <TextField.Description id="slug-hint" class={styles.hint}>
                  DrFed generates this identifier automatically. It cannot be
                  edited.
                </TextField.Description>

                <Show when={field.errors}>
                  {(errors) => (
                    <span
                      id="slug-error"
                      class={`${styles.notice} ${styles.error}`}
                      role="alert"
                    >
                      {errors()[0]}
                    </span>
                  )}
                </Show>
              </TextField>
            )}
          </Field>
          <Button
            class={styles.button}
            type="submit"
            disabled={isCreatingInstance()}
          >
            {buttonLabel()}
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
