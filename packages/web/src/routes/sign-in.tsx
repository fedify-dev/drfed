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
import { action, useSubmission } from "@solidjs/router";
import { commitMutation, graphql } from "relay-runtime";
import { Show } from "solid-js";
import { getRequestEvent } from "solid-js/web";

import { createRelayEnvironment } from "~/RelayEnvironment";

import "./sign-in.css";

const signInMutation = graphql`
  mutation SignInMutation($email: Email!, $verifyUrl: URITemplate) {
    loginByEmail(email: $email, verifyUrl: $verifyUrl) {
      token
    }
  }
`;

interface SignInResult {
  message: string;
  status: "error" | "success";
}

const signInAction = action(async (formData: FormData) => {
  "use server";

  const email = formData.get("email");
  if (typeof email !== "string" || email === "") {
    return {
      message: "Enter a valid email address.",
      status: "error",
    } satisfies SignInResult;
  }

  const request = getRequestEvent()?.request;
  if (request === undefined) {
    return {
      message: "Unable to determine the application URL.",
      status: "error",
    } satisfies SignInResult;
  }

  const environment = createRelayEnvironment();
  const verifyUrl = new URL("/confirm/{token}?code={code}", request.url).href;

  const result = await new Promise<SignInResult>((resolve) => {
    commitMutation(environment, {
      mutation: signInMutation,
      variables: { email, verifyUrl },
      onCompleted: (_response, errors) => {
        const errorMessage = errors?.map((e) => e.message).join("\n");

        resolve({
          message:
            errorMessage ??
            "Check your inbox for a secure sign-in link. You can close this page.",
          status: errorMessage === undefined ? "success" : "error",
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
}, "sign-in");

export default function SignInPage() {
  const signInSubmission = useSubmission(signInAction);

  const buttonLabel = () => {
    if (signInSubmission.pending === true) {
      return "Sending link…";
    }
    if (signInSubmission.result?.status === "success") {
      return "Resend sign-in link";
    }
    return "Send sign-in link";
  };

  return (
    <main class="auth-page form-page">
      <Title>Sign in — DrFed</Title>

      <section
        class="panel auth-panel form-panel"
        aria-labelledby="sign-in-title"
      >
        <header class="panel-header">
          <h1 id="sign-in-title">Sign in</h1>
          <p>Enter your email address to receive a secure sign-in link.</p>
        </header>

        <form action={signInAction} method="post">
          <label class="field">
            <span class="field-heading">
              Email address
              <span class="field-status required">Required</span>
            </span>
            <input
              name="email"
              type="email"
              autocomplete="email"
              inputmode="email"
              placeholder="you@example.com"
              required
            />
          </label>
          <button
            class="button primary"
            type="submit"
            disabled={signInSubmission.pending}
          >
            {buttonLabel()}
          </button>
        </form>

        <Show when={signInSubmission.result}>
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
