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
import { graphql } from "relay-runtime";
import { Show, Suspense } from "solid-js";
import { createLazyLoadQuery } from "solid-relay";

import { deleteSessionCookie } from "~/session.ts";

import type { HeaderAccountButtonQuery } from "./__generated__/HeaderAccountButtonQuery.graphql.ts";

import styles from "~/styles/app.module.css";

const signOutAction = action(async () => {
  "use server";
  deleteSessionCookie();
}, "sign-out");

export function HeaderAccountButton() {
  const signOut = useAction(signOutAction);
  const submission = useSubmission(signOutAction);

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
    await signOut();
    globalThis.location.replace("/");
  }

  return (
    <Suspense fallback={undefined}>
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
              onClick={() => void handleSignOut()}
            >
              Sign out
            </Button>
          </Show>
        )}
      </Show>
    </Suspense>
  );
}
