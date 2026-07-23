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

import { action, useSubmission } from "@solidjs/router";
import { Show } from "solid-js";

const signin = action(async (formData: FormData) => {
  "use server";

  const email = formData.get("email");
  if (typeof email !== "string") {
    return { ok: false, message: "이메일이 올바르지 않습니다." };
  }

  await fetch("http://0.0.0.0:8888/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: `
      mutation Login($email: Email!, $verifyUrl: URITemplate!) { loginByEmail(email: $email, verifyUrl: $verifyUrl) { token } }
      `,
      variables: {
        email,
        verifyUrl: "http://localhost:5173/confirm/{token}?code={code}",
      },
    }),
  });

  return { ok: true, message: "인증 메일을 확인해 주세요." };
}, "signin");

export default function SignInPage() {
  const submission = useSubmission(signin);

  return (
    <>
      <form action={signin} method="post">
        <input
          name="email"
          type="email"
          placeholder="example@example.com"
          required
        />
        <button type="submit">로그인</button>
      </form>
      <Show when={submission.result?.ok}>
        <dialog open aria-labelledby="login-dialog-title">
          <h2 id="login-dialog-title">로그인 요청 완료</h2>
          <p>{submission.result?.message}</p>
          <form method="dialog">
            <button type="submit">닫기</button>
          </form>
        </dialog>
      </Show>
    </>
  );
}
