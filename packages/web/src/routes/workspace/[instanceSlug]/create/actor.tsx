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
import { action, useSubmissions } from "@solidjs/router";
import { getRequestEvent } from "solid-js/web";

// FIXME: use mutation to send graphql query
// const genActorsMutation = graphql`
//   mutation genActorsMutation(
//   $instance: ID! $size: Int!
//   ) {
//     genActors(instance: $instance, size: $size) {
//       resultType: __typename

//       ... on CreateActorsSuccess {
//         actors {
//           username
//         }
//       }
//       ... on CreateActorsError {
//         type
//         message
//       }
//     }
//   }
//   )`;

type CreateActorsResult =
  | {
      payload: {
        id: string;
      };
      status: "success";
    }
  | {
      message: string;
      status: "error";
    };

const createActorsAction = action(async (formData: FormData) => {
  "use server";

  const rawSize = formData.get("size");
  if (typeof rawSize !== "string" || rawSize) {
    return {
      message: "Enter a valid number.",
      status: "error",
    } satisfies CreateActorsResult;
  }
  const size = Number(rawSize);
  if (!Number.isInteger(size) || size < 1) {
    return {
      message: "Size must be an integer greater than or equal to 1.",
      status: "error",
    } satisfies CreateActorsResult;
  }

  const request = getRequestEvent()?.request;
  if (request === undefined) {
    return {
      message: "Unable to determine the application URL.",
      status: "error",
    } satisfies CreateActorsResult;
  }

  // FIXME: fetch mutation from relay enviroment

  const result = await Promise.resolve({
    message: "Error occured.",
    status: "error",
  });
  return result;
}, "create-actors");

export default function CreateActorPage() {
  const createActorsSubmission = useSubmissions(createActorsAction);

  const buttonLabel = () => {
    if (createActorsSubmission.pending) {
      return "Creating actors...";
    }
    return "Create actors";
  };
  return (
    <main class="create-page form-page">
      <Title>Create an instance — DrFed</Title>

      <section
        class="panel create-panel form-panel"
        aria-labelledby="create-actors-title"
      >
        <header class="panel-header">
          <h1 id="create-actors-title">Create actors</h1>
          <p>Enter how many actors to create</p>
        </header>

        <form action={createActorsAction} method="post">
          <label class="field">
            <span class="field-heading">
              Size
              <span class="field-status required">Required</span>
            </span>
            <input
              name="size"
              type="text"
              autocomplete="off"
              placeholder="1"
              required
            />
          </label>

          <button
            class="button primary"
            type="submit"
            disabled={createActorsSubmission.pending}
          >
            {buttonLabel()}
          </button>
        </form>

        {/*FIXME: add submission result handling*/}
        {/*<Show when={createActorsSubmission.result?.status === "error"}>
            <p class="notice error" role="alert">
              {createActorsSubmission.result?.status === "error"
                ? createActorsSubmission.result.message
                : ""}
            </p>
          </Show>*/}
      </section>
    </main>
  );
}
