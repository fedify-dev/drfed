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

import { action, useAction, useParams, useSearchParams } from "@solidjs/router";
import { commitMutation, graphql } from "relay-runtime";
import { Show, createSignal, onMount } from "solid-js";

import { createRelayEnvironment } from "~/RelayEnviroment";

import type { CompleteLoginChallenge } from "./__generated__/CompleteLoginChallenge.graphql.ts";

const completeLoginChallengeMutation = graphql`
  mutation CompleteLoginChallenge($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      accessToken
      expires
    }
  }
`;

type CompleteLogInResult =
  | {
      message: string;
      status: "error";
    }
  | {
      accessToken: string;
      expires: string;
      message: string;
      status: "success";
    };

const completeLoginChallengeAction = action(
  async ({ token, code }: { token: string; code: string }) => {
    "use server";

    const environment = createRelayEnvironment();

    const result = await new Promise<CompleteLogInResult>((resolve) => {
      commitMutation<CompleteLoginChallenge>(environment, {
        mutation: completeLoginChallengeMutation,
        variables: { token, code },
        onCompleted: (response, errors) => {
          const errorMessage = errors?.map((e) => e.message).join("\n");

          if (errorMessage !== undefined) {
            resolve({
              message: errorMessage,
              status: "error",
            });
            return;
          }

          const session = response.completeLoginChallenge;
          if (
            session?.accessToken == undefined ||
            typeof session.expires !== "string"
          ) {
            resolve({
              message: "The sign-in link is invalid or expired.",
              status: "error",
            });
            return;
          }

          resolve({
            accessToken: session.accessToken,
            expires: session.expires,
            message: "Signing in…",
            status: "success",
          });
        },
        onError: (error) => {
          resolve({
            message: error.message,
            status: "error",
          });
        },
      });
    });

    return result;
  },
  "complete-login-challenge",
);

export default function ConfirmPage() {
  const params = useParams<{ token: string }>();
  const [searchParams] = useSearchParams<{ code?: string }>();
  const completeLoginChallenge = useAction(completeLoginChallengeAction);
  const [result, setResult] = createSignal<CompleteLogInResult>();

  onMount(() => {
    async function complete() {
      try {
        const completeResult = await completeLoginChallenge({
          token: params.token,
          code: searchParams.code ?? "",
        });
        setResult(completeResult);

        if (completeResult.status === "error") {
          return;
        }

        const response = await fetch("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessToken: completeResult.accessToken,
            expires: completeResult.expires,
          }),
        });

        if (!response.ok) {
          setResult({
            message: "Unable to save a session.",
            status: "error",
          });
          return;
        }

        globalThis.location.assign("/");
      } catch (error) {
        setResult({
          message:
            error instanceof Error
              ? error.message
              : "Unable to complete sign-in.",
          status: "error",
        });
      }
    }

    void complete();
  });

  return (
    <Show when={result()}>
      {(value) => <output class={value().status}>{value().message}</output>}
    </Show>
  );
}
