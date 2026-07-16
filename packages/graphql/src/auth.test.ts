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

// oxlint-disable max-lines-per-function max-statements no-magic-numbers

import { deepEqual, equal, ok } from "node:assert/strict";
import { describe, it } from "node:test";

import { schema } from "@drfed/models";

import { withTestHarness } from "./harness.test.ts";

const okStatus = 200;
const accountId = "00000000-0000-4000-8000-000000000001";
const email = "noreply@drfed.org";
const verifyUrl = "https://drfed.org/transports/mock?token={token}&code={code}";

const loginMutation = `
  mutation Login($email: Email!, $verifyUrl: String) {
    loginByEmail(email: $email, verifyUrl: $verifyUrl) {
      ... on SendMail {
        token
      }
    }
  }
`;

const completeLoginMutation = `
  mutation CompleteLogin($token: UUID!, $code: String!) {
    completeLoginChallenge(token: $token, code: $code) {
      id
      accessToken
      account {
        uuid
        email
      }
    }
  }
`;

const viewerQuery = `
  query Viewer {
    viewer {
      uuid
      email
    }
  }
`;

const revokeSessionMutation = `
  mutation RevokeSession($session: UUID!) {
    revokeSession(session: $session) {
      revoke
    }
  }
`;

const loginUrlPattern =
  /https:\/\/drfed\.org\/transports\/mock\?token=[0-9a-f-]+&code=[0-9a-z]+/u;

describe("email authentication", () => {
  it("logs in, authenticates the viewer, and revokes the session", async () => {
    await withTestHarness(async ({ db, mailer, post }) => {
      await db.insert(schema.accounts).values({
        id: accountId,
        email,
        name: "Login Test",
      });

      const loginResponse = await post({
        query: loginMutation,
        variables: { email, verifyUrl },
      });
      equal(loginResponse.status, okStatus);

      const loginBody = await loginResponse.json();
      equal(loginBody.errors, undefined);

      const { token } = loginBody.data.loginByEmail;
      equal(typeof token, "string");

      const messages = mailer.getSentMessages();
      equal(messages.length, 1);

      const [message] = messages;
      ok(message);
      equal(typeof message.content.text, "string");

      const urlMatch = message.content.text?.match(loginUrlPattern);
      ok(urlMatch);

      const loginUrl = new URL(urlMatch[0]);
      equal(loginUrl.origin, "https://drfed.org");
      equal(loginUrl.pathname, "/transports/mock");
      equal(loginUrl.searchParams.get("token"), token);

      const code = loginUrl.searchParams.get("code");
      ok(code);

      const completeResponse = await post({
        query: completeLoginMutation,
        variables: { token, code },
      });
      equal(completeResponse.status, okStatus);

      const completeBody = await completeResponse.json();
      equal(completeBody.errors, undefined);

      const session = completeBody.data.completeLoginChallenge;
      ok(session);
      equal(session.account.uuid, accountId);
      equal(session.account.email, email);
      equal(typeof session.accessToken, "string");

      const authorization = {
        headers: { authorization: `Bearer ${session.accessToken}` },
      };
      const viewerResponse = await post({ query: viewerQuery }, authorization);
      equal(viewerResponse.status, okStatus);
      deepEqual(await viewerResponse.json(), {
        data: { viewer: { uuid: accountId, email } },
      });

      const revokeResponse = await post(
        {
          query: revokeSessionMutation,
          variables: { session: session.id },
        },
        authorization,
      );
      equal(revokeResponse.status, okStatus);
      deepEqual(await revokeResponse.json(), {
        data: { revokeSession: { revoke: true } },
      });

      const revokedViewerResponse = await post(
        { query: viewerQuery },
        authorization,
      );
      equal(revokedViewerResponse.status, okStatus);
      deepEqual(await revokedViewerResponse.json(), {
        data: { viewer: null },
      });
    });
  });
});
