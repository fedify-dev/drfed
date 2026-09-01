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
import { Title } from "@solidjs/meta";
import { useNavigate } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show, createSignal } from "solid-js";
import { createMutation } from "solid-relay";

import type { CreateInstanceMutation } from "./__generated__/CreateInstanceMutation.graphql.ts";

import styles from "~/form.module.css";

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

export default function CreateInstancePage() {
  const navigate = useNavigate();
  const [errorMessage, setErrorMessage] = createSignal<string>();
  const [commitCreateInstance, isCreatingInstance] =
    createMutation<CreateInstanceMutation>(createInstanceMutation);

  const submit = (event: SubmitEvent & { currentTarget: HTMLFormElement }) => {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const slug = formData.get("slug");
    if (typeof slug !== "string" || slug === "") {
      setErrorMessage("Enter a valid slug.");
      return;
    }

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

        <form class={styles.form} onSubmit={submit}>
          <label class={styles.field}>
            <span class={styles.fieldHeading}>
              Slug
              <span class={styles.fieldStatus}>Generated · Read only</span>
            </span>
            <input
              class={styles.input}
              name="slug"
              type="text"
              value={`${faker.word.noun()}-${faker.word.noun()}-${faker.word.noun()}`}
              aria-describedby="slug-hint"
              readOnly
            />
            <span id="slug-hint" class={styles.hint}>
              DrFed generates this identifier automatically. It cannot be
              edited.
            </span>
          </label>
          <button
            class={styles.button}
            type="submit"
            disabled={isCreatingInstance()}
          >
            {buttonLabel()}
          </button>
        </form>

        <Show when={errorMessage()}>
          <p class={`${styles.notice} ${styles.error}`} role="alert">
            {errorMessage()}
          </p>
        </Show>
      </section>
    </main>
  );
}
