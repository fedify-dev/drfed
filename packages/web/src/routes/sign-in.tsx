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

import { Field, Form, type SubmitHandler, createForm } from "@formisch/solid";
import { Alert } from "@kobalte/core/alert";
import { Button } from "@kobalte/core/button";
import { TextField } from "@kobalte/core/text-field";
import { Title } from "@solidjs/meta";
import { graphql } from "relay-runtime";
import { Match, Show, Switch, createSignal } from "solid-js";
import { createMutation } from "solid-relay";
import * as v from "valibot";

import type { SignInMutation } from "./__generated__/SignInMutation.graphql.ts";

import styles from "~/styles/form.module.css";

const signInMutation = graphql`
  mutation SignInMutation($email: Email!, $verifyUrl: URITemplate) {
    loginByEmail(email: $email, verifyUrl: $verifyUrl) {
      token
    }
  }
`;

const signInSchema = v.object({
  email: v.pipe(
    v.string(),
    v.trim(),
    v.nonEmpty("Enter a valid email address."),
    v.email("Enter a valid email address."),
  ),
});

interface SignInResult {
  message: string;
  status: "error" | "success";
}

export default function SignInPage() {
  const [result, setResult] = createSignal<SignInResult>();
  const [commitSignIn, isSigningIn] =
    createMutation<SignInMutation>(signInMutation);
  const signInForm = createForm({
    schema: signInSchema,
    initialInput: { email: "" },
  });

  const submit: SubmitHandler<typeof signInSchema> = ({ email }) => {
    const verifyUrl = `${globalThis.location.origin}/confirm/{token}?code={code}`;
    setResult(undefined);
    commitSignIn({
      variables: { email, verifyUrl },
      onCompleted: (_response, errors) => {
        const graphQLErrors = errors ?? [];
        if (graphQLErrors.length > 0) {
          setResult({
            message: graphQLErrors.map((error) => error.message).join("\n"),
            status: "error",
          });
          return;
        }

        setResult({
          message:
            "Check your inbox for a secure sign-in link. You can close this page.",
          status: "success",
        });
      },
      onError: (error) => {
        setResult({
          message: error.message,
          status: "error",
        });
      },
    });
  };

  return (
    <main class={styles.page}>
      <Title>Sign in — DrFed</Title>

      <section class={styles.panel} aria-labelledby="sign-in-title">
        <header class={styles.header}>
          <h1 id="sign-in-title">Sign in</h1>
          <p>Enter your email address to receive a secure sign-in link.</p>
        </header>

        <Form class={styles.form} of={signInForm} onSubmit={submit}>
          <Field of={signInForm} path={["email"]}>
            {(field) => (
              <TextField
                class={styles.field}
                name={field.props.name}
                value={field.input ?? ""}
                required
              >
                <TextField.Label class={styles.fieldHeading}>
                  Email address
                  <span class={`${styles.fieldStatus} ${styles.required}`}>
                    Required
                  </span>
                </TextField.Label>
                <TextField.Input
                  {...field.props}
                  class={styles.input}
                  type="email"
                  autocomplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  aria-invalid={Boolean(field.errors)}
                  aria-describedby={field.errors ? "email-error" : undefined}
                />
                <Show when={field.errors}>
                  {(errors) => (
                    <span
                      id="email-error"
                      class={`${styles.notice} ${styles.error}`}
                      role="alert"
                    >
                      {errors()[0]}
                    </span>
                  )}
                </Show>
              </TextField>
            )}
          </Field>
          <Button class={styles.button} type="submit" disabled={isSigningIn()}>
            <Show
              when={isSigningIn()}
              fallback={
                result()?.status === "success"
                  ? "Resend sign-in link"
                  : "Send sign-in link"
              }
            >
              Sending link…
            </Show>
          </Button>
        </Form>

        <Show when={result()}>
          {(formResult) => (
            <Switch>
              <Match when={formResult().status === "error"}>
                <Alert class={`${styles.notice} ${styles.error}`}>
                  {formResult().message}
                </Alert>
              </Match>

              <Match when={formResult().status === "success"}>
                <output class={`${styles.notice} ${styles.success}`}>
                  {formResult().message}
                </output>
              </Match>
            </Switch>
          )}
        </Show>
      </section>
    </main>
  );
}
