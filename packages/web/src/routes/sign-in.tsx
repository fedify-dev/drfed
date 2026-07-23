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
  const [signIn] = createMutation<SignInMutation>(signInMutation);
  const [message, setMessage] = createSignal<string>("");

  const handleSubmit: JSX.EventHandler<HTMLFormElement, SubmitEvent> = (e) => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get("email");
    if (typeof email !== "string" || email === "") {
      return;
    }

    signIn({
      variables: {
        email,
        verifyUrl: `${globalThis.location.origin}/confirm/{token}?code={code}`,
      },
      onCompleted: (_response, errors) => {
        const [error] = errors ?? [];

        setMessage(error?.message ?? "인증 메일을 확인해 주세요.");
      },
      onError: (error) => {
        setMessage(error.message);
      },
    });
  };

  return (
    <>
      <form onSubmit={handleSubmit}>
        <input
          name="email"
          type="email"
          placeholder="example@example.com"
          required
        />
        <button type="submit">로그인</button>
      </form>
      <Show when={message() !== ""}>
        <dialog open aria-labelledby="login-dialog-title">
          <h2 id="login-dialog-title">로그인 요청 완료</h2>
          <p>{message()}</p>
          <form method="dialog">
            <button type="submit">닫기</button>
          </form>
        </dialog>
      </Show>
    </>
  );
}
