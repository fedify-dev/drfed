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

// GraphQL login through the server and frontend under test.
import assert from "node:assert/strict";

import { requestInstalledWeb } from "../../smoke-http.mts";
import type { Project } from "./harness.mts";

interface GraphQLResponse {
  data?: Record<string, unknown>;
  errors?: unknown;
}
export async function graphql(
  port: number,
  host: string,
  query: string,
  variables: Record<string, unknown> = {},
  token?: string,
): Promise<Record<string, unknown>> {
  const response = await requestInstalledWeb(
    port,
    "/graphql",
    {
      host,
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    JSON.stringify({ query, variables }),
  );
  assert.equal(response.status, 200, response.body);
  const body = JSON.parse(response.body) as GraphQLResponse;
  assert.equal(body.errors, undefined, response.body);
  assert.ok(body.data);
  return body.data;
}

export async function requestLogin(
  port: number,
  origin: string,
  email = "operator@example.com",
): Promise<string> {
  const data = await graphql(
    port,
    new URL(origin).host,
    `
      mutation Login($email: Email!, $verifyUrl: URITemplate!) {
        loginByEmail(email: $email, verifyUrl: $verifyUrl) {
          challengeId
        }
      }
    `,
    {
      email,
      verifyUrl: `${origin}/login?challengeId={challengeId}&code={code}`,
    },
  );
  const { challengeId } = data.loginByEmail as { challengeId?: string };
  assert.ok(challengeId);
  return challengeId;
}

/**
 * Log in through the link that the logtape mail transport printed.
 * @returns The account UUID the new session belongs to.
 */
export async function logIn(
  project: Project,
  port: number,
  origin: string,
): Promise<string> {
  const challengeId = await requestLogin(port, origin);
  const link = await project.waitFor(
    new RegExp(
      `${origin.replaceAll(".", "\\.")}/login\\?challengeId=${challengeId}&(?:amp;)?code=(?<code>[A-Za-z0-9]+)`,
      "u",
    ),
  );
  const { host } = new URL(origin);
  const completed = await graphql(
    port,
    host,
    `
      mutation Complete($challengeId: UUID!, $code: String!) {
        completeLoginChallenge(challengeId: $challengeId, code: $code) {
          accessToken
        }
      }
    `,
    { challengeId, code: link.groups!.code },
  );
  const token = (completed.completeLoginChallenge as { accessToken?: string })
    .accessToken;
  assert.ok(token, "Login completes with an access token.");
  const viewer = await graphql(
    port,
    host,
    "{ viewer { uuid email } }",
    {},
    token,
  );
  const account = viewer.viewer as { uuid: string; email: string };
  assert.equal(account.email, "operator@example.com");
  return account.uuid;
}

export async function expectPage(port: number, host: string): Promise<void> {
  const page = await requestInstalledWeb(port, "/", { host });
  assert.equal(page.status, 200);
  assert.match(page.body, /DrFed/u);
  const icon = await requestInstalledWeb(port, "/icon.svg", { host });
  assert.equal(icon.status, 200);
}
