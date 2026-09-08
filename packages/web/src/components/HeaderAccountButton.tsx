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

import { Button } from "@kobalte/core/button";
import { A, action, useAction, useSubmission } from "@solidjs/router";
import { commitMutation, graphql } from "relay-runtime";
import { ErrorBoundary, Show, Suspense, createSignal } from "solid-js";
import { createLazyLoadQuery } from "solid-relay";

import { createRelayEnvironment } from "~/RelayEnvironment.ts";
import { deleteSessionCookie } from "~/session.ts";

import type { HeaderAccountButtonQuery } from "./__generated__/HeaderAccountButtonQuery.graphql.ts";
import type { RevokeSession } from "./__generated__/RevokeSession.graphql.ts";

import styles from "~/styles/app.module.css";

const revokeSessionMutation = graphql`
  mutation RevokeSession {
    revokeSession {
      revoke
    }
  }
`;

interface revokeSessionResult {
  message: string;
  status: "error" | "success";
}

const signOutAction = action(async () => {
  "use server";

  const environment = createRelayEnvironment();

  const result = await new Promise<revokeSessionResult>((resolve) => {
    commitMutation<RevokeSession>(environment, {
      mutation: revokeSessionMutation,
      variables: {},
      onCompleted: (response, errors) => {
        const graphQLErrors = errors ?? [];

        if (graphQLErrors.length > 0) {
          resolve({
            message: graphQLErrors.map((error) => error.message).join("\n"),
            status: "error",
          });
          return;
        }

        try {
          deleteSessionCookie();
        } catch {
          resolve({
            message: "Unable to delete session in cookie",
            status: "error",
          });
          return;
        }

        resolve({
          message: "Signed Out",
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
}, "sign-out");

export function HeaderAccountButton() {
  const signOut = useAction(signOutAction);
  const submission = useSubmission(signOutAction);
  const [result, setResult] = createSignal<revokeSessionResult>();
  const query = createLazyLoadQuery<HeaderAccountButtonQuery>(
    graphql`
      query HeaderAccountButtonQuery {
        viewer {
          name
        }
      }
    `,
    {},
  );

  async function handleSignOut() {
    try {
      const signOutResult = await signOut();
      setResult(signOutResult);

      if (signOutResult.status === "success") {
        globalThis.location.replace("/");
      }
    } catch (error) {
      setResult({
        message: error instanceof Error ? error.message : "Unable to sign out.",
        status: "error",
      });
    }
  }

  return (
    <ErrorBoundary fallback={() => <></>}>
      <Suspense fallback={<div class={styles.headerAction}>Signing Out..</div>}>
        <Show when={query()}>
          {(data) => (
            <Show
              when={data().viewer}
              fallback={
                <A class={styles.headerAction} href="/sign-in">
                  Sign in
                </A>
              }
            >
              <Button
                type="button"
                class={styles.headerAction}
                disabled={submission.pending}
                title={
                  result()?.status === "error" ? result()?.message : undefined
                }
                aria-live="polite"
                onClick={() => void handleSignOut()}
              >
                {result()?.status === "error"
                  ? "Sign out failed — retry"
                  : "Sign out"}
              </Button>
            </Show>
          )}
        </Show>
      </Suspense>
    </ErrorBoundary>
  );
}
