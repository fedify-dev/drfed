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
import { graphql } from "relay-runtime";
import { type JSX, Show, createSignal } from "solid-js";
import { createMutation } from "solid-relay";

import type { SignInMutation } from "./__generated__/SignInMutation.graphql";

const signInMutation = graphql`
  mutation SignInMutation($email: Email!, $verifyUrl: URITemplate) {
    loginByEmail(email: $email, verifyUrl: $verifyUrl) {
      token
    }
  }
`;

export default function SignInPage() {
  const [signIn, isPending] = createMutation<SignInMutation>(signInMutation);
  const [result, setResult] = createSignal<{
    message: string;
    status: "error" | "success";
  }>();
  const buttonLabel = () => {
    if (isPending()) {
      return "Sending link…";
    }
    if (result()?.status === "success") {
      return "Resend sign-in link";
    }
    return "Send sign-in link";
  };

  const handleSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent> = (e) => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get("email");
    if (typeof email !== "string" || email === "") {
      return;
    }

    setResult();
    signIn({
      variables: {
        email,
        verifyUrl: `${globalThis.location.origin}/confirm/{token}?code={code}`,
      },
      onCompleted: (_response, errors) => {
        const [error] = errors ?? [];

        setResult({
          message:
            error?.message ??
            "Check your inbox for a secure sign-in link. You can close this page.",
          status: error === undefined ? "success" : "error",
        });
      },
      onError: (error) => {
        setResult({ message: error.message, status: "error" });
      },
    });
  };

  return (
    <main class="auth-page">
      <Title>Sign in — DrFed</Title>

      <section class="panel auth-panel" aria-labelledby="sign-in-title">
        <header class="panel-header">
          <h1 id="sign-in-title">Sign in</h1>
          <p>Enter your email address to receive a secure sign-in link.</p>
        </header>

        <form onSubmit={handleSubmit}>
          <label class="field">
            Email address
            <input
              name="email"
              type="email"
              autocomplete="email"
              inputmode="email"
              placeholder="you@example.com"
              required
            />
          </label>
          <button class="button primary" type="submit" disabled={isPending()}>
            {buttonLabel()}
          </button>
        </form>

        <Show when={result()}>
          {(formResult) => (
            <p
              class={`notice ${formResult().status}`}
              role={formResult().status === "error" ? "alert" : "status"}
            >
              {formResult().message}
            </p>
          )}
        </Show>
      </section>
    </main>
  );
}
