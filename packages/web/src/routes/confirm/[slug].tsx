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

import { useParams, useSearchParams } from "@solidjs/router";
import { graphql } from "relay-runtime";
import { Show, createSignal, onMount } from "solid-js";
import { createMutation } from "solid-relay";

import type { CompleteLoginChallenge } from "./__generated__/CompleteLoginChallenge.graphql";

const signCompleteMutation = graphql`
  mutation CompleteLoginChallenge($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      accessToken
      expires
    }
  }
`;

export default function ConfirmPage() {
  const params = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams<{ code?: string }>();
  const [complete] =
    createMutation<CompleteLoginChallenge>(signCompleteMutation);
  const [result, setResult] = createSignal<{
    message: string;
    status: "error" | "success";
  }>();

  function showSessionError() {
    setResult({
      message: "Unable to save a session",
      status: "error",
    });
  }

  onMount(() => {
    const { code } = searchParams;
    const { slug: token } = params;

    if (token === "" || code == undefined || code === "") {
      return;
    }

    async function saveSession(accessToken: string, expires: string) {
      try {
        const response = await fetch("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessToken,
            expires,
          }),
        });

        if (!response.ok) {
          showSessionError();
          return;
        }
        // Redirect to the home page
        globalThis.location.assign("/");
      } catch {
        showSessionError();
      }
    }

    complete({
      variables: { token, code },
      onCompleted(data) {
        const session = data.completeLoginChallenge;
        if (
          session?.accessToken == undefined ||
          typeof session.expires !== "string"
        ) {
          setResult({
            message: "The sign-in link is invalid or expired.",
            status: "error",
          });
          return;
        }

        void saveSession(session.accessToken, session.expires);
      },
      onError: (error) => {
        setResult({ message: error.message, status: "error" });
      },
    });
  });

  return (
    <Show when={result()}>
      {(value) => <output class={value().status}>{value().message}</output>}
    </Show>
  );
}
