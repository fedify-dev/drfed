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
import { Title } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show, createSignal } from "solid-js";
import { createMutation } from "solid-relay";
import * as v from "valibot";

import type { CreateInstanceMutation } from "./__generated__/CreateInstanceMutation.graphql.ts";

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
  slug: v.pipe(v.string(), v.trim(), v.nonEmpty("Enter a valid slug.")),
});

export default function CreateInstancePage() {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = createSignal<string>();
  const [commitCreateInstance, isCreatingInstance] =
    createMutation<CreateInstanceMutation>(createInstanceMutation);

  const createInstanceForm = createForm({
    schema: createInstanceSchema,
    initialInput: {
      slug: `${faker.word.noun()}-${faker.word.noun()}-${faker.word.noun()}`,
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
    <main class="create-page form-page">
      <Title>Create an instance — DrFed</Title>

      <section
        class="panel create-panel form-panel"
        aria-labelledby="create-instance-title"
      >
        <header class="panel-header">
          <h1 id="create-instance-title">Create an instance</h1>
          <p>Review the generated identifier for your new instance.</p>
        </header>

        <Form of={createInstanceForm} onSubmit={submit}>
          <Field of={createInstanceForm} path={["slug"]}>
            {(field) => (
              <label class="field">
                <span class="field-heading">
                  Slug
                  <span class="field-status">Generated · Read only</span>
                </span>
                <input
                  {...field.props}
                  name="slug"
                  type="text"
                  value={field.input ?? ""}
                  aria-invalid={Boolean(field.errors)}
                  aria-describedby={
                    field.errors ? "slug-hint slug-error" : "slug-hint"
                  }
                  readOnly
                />
                <span id="slug-hint" class="field-hint">
                  DrFed generates this identifier automatically. It cannot be
                  edited.
                </span>
                <Show when={field.errors}>
                  {(errors) => (
                    <span id="slug-error" class="field-error" role="alert">
                      {errors()[0]}
                    </span>
                  )}
                </Show>
              </label>
            )}
          </Field>
          <button
            class="button primary"
            type="submit"
            disabled={isCreatingInstance()}
          >
            {buttonLabel()}
          </button>
        </Form>
        <Show when={errorMessage()}>
          <p class="notice error" role="alert">
            {errorMessage()}
          </p>
        </Show>
      </section>
    </main>
  );
}
