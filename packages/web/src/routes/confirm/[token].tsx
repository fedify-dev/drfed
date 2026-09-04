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

import { createRelayEnvironment } from "~/RelayEnvironment.ts";
import { setSessionCookie } from "~/session.ts";

import type { CompleteLoginChallenge } from "./__generated__/CompleteLoginChallenge.graphql.ts";

const completeLoginChallengeMutation = graphql`
  mutation CompleteLoginChallenge($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      accessToken
      expires
    }
  }
`;

interface CompleteLoginResult {
  message: string;
  status: "error" | "success";
}

const completeLoginChallengeAction = action(
  async ({ token, code }: { token: string; code: string }) => {
    "use server";

    const environment = createRelayEnvironment();

    const result = await new Promise<CompleteLoginResult>((resolve) => {
      commitMutation<CompleteLoginChallenge>(environment, {
        mutation: completeLoginChallengeMutation,
        variables: { token, code },
        onCompleted: (response, errors) => {
          const graphQLErrors = errors ?? [];

          if (graphQLErrors.length > 0) {
            resolve({
              message: graphQLErrors.map((error) => error.message).join("\n"),
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

          try {
            setSessionCookie(session.accessToken, session.expires);
          } catch {
            resolve({
              message: "Unable to save a session.",
              status: "error",
            });
            return;
          }

          resolve({
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
  const [result, setResult] = createSignal<CompleteLoginResult>();

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
    <Show when={result()} fallback={<output>Signing in…</output>}>
      {(value) => <output class={value().status}>{value().message}</output>}
    </Show>
  );
}
