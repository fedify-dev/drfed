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
import { action, redirect, useSubmission } from "@solidjs/router";
import { commitMutation, graphql } from "relay-runtime";
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
      return "Making an instance";
    }
    return "Done.";
  };

  return (
    <main class="create-page">
      <Title>Create An Instance — DrFed</Title>

      <section
        class="panel create-panel"
        aria-labelledby="create-instance-title"
      >
        <header class="panel-header">
          <h1 id="create-instance-title">Create Instance</h1>
          <p>Enter your instance name.</p>
        </header>

        <form action={createInstanceAction} method="post">
          <label class="field">
            Name
            <input
              name="name"
              type="text"
              inputmode="text"
              placeholder="Your Instance Name"
              required
            />
          </label>
          <label class="field">
            Slug
            <input
              name="slug"
              type="text"
              value={`${faker.word.noun()}-${faker.word.noun()}-${faker.word.noun()}`}
              readOnly
              required
            />
          </label>
          <button
            class="button primary"
            type="submit"
            disabled={createInstanceSubmission.pending}
          >
            {buttonLabel()}
          </button>
        </form>
      </section>
    </main>
  );
}
