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
import { action, redirect, useSubmission } from "@solidjs/router";
import { commitMutation, graphql } from "relay-runtime";
import { Show } from "solid-js";
import { getRequestEvent } from "solid-js/web";

import { createRelayEnvironment } from "~/RelayEnvironment";

import type { CreateInstanceMutation } from "./__generated__/CreateInstanceMutation.graphql";

const createInstanceMutation = graphql`
  mutation CreateInstanceMutation(
    $slug: String! # $name: String
  ) {
    createInstance(slug: $slug) {
      ... on Instance {
        slug
      }
    }
  }
`;

type CreateInstanceResult =
  | {
      payload: {
        slug: string;
      };
      status: "success";
    }
  | {
      message: string;
      status: "error";
    };

const createInstanceAction = action(async (formData: FormData) => {
  "use server";

  const slug = formData.get("slug");
  if (typeof slug !== "string" || slug === "") {
    return {
      message: "Enter a valid slug.",
      status: "error",
    } satisfies CreateInstanceResult;
  }

  const request = getRequestEvent()?.request;
  if (request === undefined) {
    return {
      message: "Unable to determine the application URL.",
      status: "error",
    } satisfies CreateInstanceResult;
  }

  const environment = createRelayEnvironment();

  const result = await new Promise<CreateInstanceResult>((resolve) => {
    commitMutation<CreateInstanceMutation>(environment, {
      mutation: createInstanceMutation,
      variables: { slug },
      onCompleted: (response, errors) => {
        const errorMessage = errors?.map((e) => e.message).join("\n");

        if (typeof errorMessage == "string") {
          resolve({
            message: errorMessage,
            status: "error",
          });
        } else if (response.createInstance.slug === undefined) {
          resolve({
            message: "Empty Slug Returned",
            status: "error",
          });
        } else {
          resolve({
            payload: {
              slug: response.createInstance.slug,
            },
            status: "success",
          });
        }
      },
      onError: (error) => {
        resolve({
          message: error.message,
          status: "error",
        });
      },
    });
  });

  if (result.status === "error") {
    return result;
  }

  return redirect(`/workspace/`);
}, "create-instance");

export default function CreateInstancePage() {
  const createInstanceSubmission = useSubmission(createInstanceAction);

  const buttonLabel = () => {
    if (createInstanceSubmission.pending === true) {
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
          <p>Name your new ActivityPub testing environment.</p>
        </header>

        <form action={createInstanceAction} method="post">
          <label class="field">
            <span class="field-heading">
              Name
              <span class="field-status required">Required</span>
            </span>
            <input
              name="name"
              type="text"
              autocomplete="off"
              placeholder="My test instance"
              required
            />
          </label>
          <label class="field">
            <span class="field-heading">
              Slug
              <span class="field-status">Generated · Read only</span>
            </span>
            <input
              name="slug"
              type="text"
              value={`${faker.word.noun()}-${faker.word.noun()}-${faker.word.noun()}`}
              aria-describedby="slug-hint"
              readOnly
            />
            <span id="slug-hint" class="field-hint">
              DrFed generates this identifier automatically. It cannot be
              edited.
            </span>
          </label>
          <button
            class="button primary"
            type="submit"
            disabled={createInstanceSubmission.pending}
          >
            {buttonLabel()}
          </button>
        </form>

        <Show when={createInstanceSubmission.result?.status === "error"}>
          <p class="notice error" role="alert">
            {createInstanceSubmission.result?.status === "error"
              ? createInstanceSubmission.result.message
              : ""}
          </p>
        </Show>
      </section>
    </main>
  );
}
