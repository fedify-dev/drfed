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
import { setCookie } from "@solidjs/start/http";
import { graphql } from "relay-runtime";
import { Show, onMount } from "solid-js";
import { createMutation } from "solid-relay";

import type { CompleteLoginChallenge } from "./__generated__/CompleteLoginChallenge.graphql";

const CompleteLoginChallenge = graphql`
  mutation CompleteLoginChallenge($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      accessToken
    }
  }
`;

export default function ConfirmPage() {
  const params = useParams<{ slug: string }>();
  const [searchParams] = useSearchParams<{ code: string }>();
  const [completeLogin, isPending] = createMutation<CompleteLoginChallenge>(
    CompleteLoginChallenge,
  );

  onMount(() => {
    const { slug: token } = params;
    const { code } = searchParams;

    if (
      typeof token !== "string" ||
      token === "" ||
      typeof code !== "string" ||
      code === ""
    ) {
      return;
    }

    completeLogin({
      variables: { token, code },
      onCompleted(data) {
        const accessToken = data.completeLoginChallenge?.accessToken;

        if (accessToken == undefined) {
          return;
        }
        setCookie("accessToken", accessToken, { path: "/" });
      },
    });
  });

  return (
    <Show when={!isPending()} fallback={<div>확인 중입니다...</div>}>
      <div>완료완료</div>
    </Show>
  );
}
