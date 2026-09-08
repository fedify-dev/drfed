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

// oxlint-disable max-statements no-magic-numbers

import { deepEqual, equal, ok } from "node:assert/strict";

import { schema } from "@drfed/models";
import type { Uuid } from "@drfed/models/uuid";
import { describe, it } from "@logtape/testing-node/autoload";
import { eq } from "drizzle-orm";

import { type TestHarness, withTestHarness } from "./harness.test.ts";

const okStatus = 200;
const accountId = "00000000-0000-4000-8000-000000000001";
const email = "noreply@drfed.org";
const verifyUrl =
  "https://drfed.org/transports/mock?challengeId={challengeId}&code={code}";
const memberId = "00000000-0000-4000-8000-000000000002";
const memberEmail = "member@example.com";
const instanceId = "00000000-0000-4000-8000-000000000101";

const loginMutation = `
  mutation Login($email: Email!, $verifyUrl: URITemplate) {
    loginByEmail(email: $email, verifyUrl: $verifyUrl) {
      ... on LoginChallenge {
        challengeId
      }
    }
  }
`;

const completeLoginMutation = `
  mutation CompleteLogin($challengeId: UUID!, $code: String!) {
    completeLoginChallenge(challengeId: $challengeId, code: $code) {
      id
      accessToken
      account {
        uuid
        email
      }
    }
  }
`;

const completeLoginReachingOthersMutation = `
  mutation CompleteLoginReachingOthers($challengeId: UUID!, $code: String!) {
    completeLoginChallenge(challengeId: $challengeId, code: $code) {
      account {
        uuid
        email
        instances {
          edges {
            node {
              members {
                edges {
                  node {
                    uuid
                    email
                  }
                }
              }
            }
          }
        }
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
  /https:\/\/drfed\.org\/transports\/mock\?challengeId=[0-9a-f-]+&code=[0-9a-z]+/u;

/**
 * Runs the login-by-email flow far enough to obtain a challenge ID and the
 * one-time code mailed with it.
 *
 * @param post The harness request helper.
 * @param mailer The harness mock mailer.
 * @returns The challenge ID and its one-time code.
 */
async function requestLoginCode(
  post: TestHarness["post"],
  mailer: TestHarness["mailer"],
): Promise<{ challengeId: Uuid; code: string }> {
  const loginResponse = await post({
    query: loginMutation,
    variables: { email, verifyUrl },
  });
  equal(loginResponse.status, okStatus);
  const loginBody = await loginResponse.json();
  equal(loginBody.errors, undefined);
  const { challengeId } = loginBody.data.loginByEmail;

  const [message] = mailer.getSentMessages();
  ok(message);
  const urlMatch = message.content.text?.match(loginUrlPattern);
  ok(urlMatch);
  const code = new URL(urlMatch[0]).searchParams.get("code");
  ok(code);
  return { challengeId, code };
}

describe("email authentication", () => {
  it("does not let the login grant reach another account's email", async () => {
    await withTestHarness(async ({ db, mailer, post }) => {
      await db.insert(schema.accounts).values([
        { id: accountId, email, name: "Login Test" },
        { id: memberId, email: memberEmail, name: "Fellow Member" },
      ]);
      await db
        .insert(schema.instances)
        .values({ id: instanceId, host: "shared.example.com" });
      await db.insert(schema.instanceMembers).values([
        { accountId, instanceId, accepted: new Date() },
        { accountId: memberId, instanceId, accepted: new Date() },
      ]);

      const { challengeId, code } = await requestLoginCode(post, mailer);

      // `Session.account` grants `ownAccount`, but the grant must cover only
      // the viewer's own account -- not every account reachable underneath it.
      // This request carries no Authorization header at all.
      const response = await post({
        query: completeLoginReachingOthersMutation,
        variables: { challengeId, code },
      });

      equal(response.status, okStatus);
      const body = await response.json();
      const { account } = body.data.completeLoginChallenge;
      equal(account.uuid, accountId);
      equal(account.email, email);

      const members = account.instances.edges[0].node.members.edges;
      const fellow = members.find(
        (edge: { node: { uuid: string } }) => edge.node.uuid === memberId,
      );
      ok(fellow);
      equal(fellow.node.email, null);
      ok(
        body.errors.some(
          (e: { message: string }) =>
            e.message === "Not authorized to resolve Account.email",
        ),
      );
    });
  });

  it("returns a challenge ID without creating a challenge for an unknown email", async () => {
    await withTestHarness(async ({ db, mailer, post }) => {
      const response = await post({
        query: loginMutation,
        variables: { email, verifyUrl },
      });
      const body = await response.json();
      equal(body.errors, undefined);
      equal(typeof body.data.loginByEmail.challengeId, "string");
      equal(mailer.getSentMessages().length, 0);
      equal((await db.query.loginChallenges.findMany()).length, 0);
    });
  });

  it("mails the public ID and plaintext code when no URL is supplied", async () => {
    await withTestHarness(async ({ db, mailer, post }) => {
      await db
        .insert(schema.accounts)
        .values({ id: accountId, email, name: "Login Test" });
      const response = await post({
        query: loginMutation,
        variables: { email },
      });
      const body = await response.json();
      equal(body.errors, undefined);
      const { challengeId } = body.data.loginByEmail;
      const row = await db.query.loginChallenges.findFirst({
        where: { id: challengeId },
      });
      ok(row);
      equal(row.code.length, schema.LOGIN_CHALLENGE_CODE_LENGTH);
      const [message] = mailer.getSentMessages();
      ok(
        message?.content.text?.includes(
          `challenge ID: ${challengeId} and code: ${row.code}`,
        ),
      );
    });
  });

  it("rejects wrong codes and expired or missing challenges without creating sessions", async () => {
    await withTestHarness(async ({ db, mailer, post }) => {
      await db
        .insert(schema.accounts)
        .values({ id: accountId, email, name: "Login Test" });
      const { challengeId, code } = await requestLoginCode(post, mailer);
      const row = await db.query.loginChallenges.findFirst({
        where: { id: challengeId },
      });
      equal(row?.code, code);
      const invalidRequests = [
        { challengeId, code: "wrong-code" },
        { challengeId, code: `${code[0] === "0" ? "1" : "0"}${code.slice(1)}` },
        { challengeId: crypto.randomUUID(), code },
      ];
      const invalidBodies = await Promise.all(
        invalidRequests.map(async (variables) =>
          (await post({ query: completeLoginMutation, variables })).json(),
        ),
      );
      for (const body of invalidBodies) {
        equal(body.errors, undefined);
        equal(body.data.completeLoginChallenge, null);
      }
      equal(
        (
          await db.query.loginChallenges.findFirst({
            where: { id: challengeId },
          })
        )?.consumed,
        null,
      );
      await db
        .update(schema.loginChallenges)
        .set({ expires: new Date(0) })
        .where(eq(schema.loginChallenges.id, challengeId));
      const expired = await (
        await post({
          query: completeLoginMutation,
          variables: { challengeId, code },
        })
      ).json();
      equal(expired.errors, undefined);
      equal(expired.data.completeLoginChallenge, null);
      equal((await db.query.sessions.findMany()).length, 0);
    });
  });

  it("creates only one session for competing completions and rejects replay", async () => {
    await withTestHarness(async ({ db, mailer, post }) => {
      await db
        .insert(schema.accounts)
        .values({ id: accountId, email, name: "Login Test" });
      const { challengeId } = await requestLoginCode(post, mailer);
      // Use a deterministic letter-containing code to exercise case folding.
      await db
        .update(schema.loginChallenges)
        .set({ code: "abc123" })
        .where(eq(schema.loginChallenges.id, challengeId));
      const request = {
        query: completeLoginMutation,
        variables: { challengeId: challengeId.toUpperCase(), code: "ABC123" },
      };
      const responses = await Promise.all([post(request), post(request)]);
      const bodies = await Promise.all(
        responses.map((response) => response.json()),
      );
      bodies.forEach((body) => equal(body.errors, undefined));
      equal(
        bodies.filter((body) => body.data.completeLoginChallenge != null)
          .length,
        1,
      );
      equal((await db.query.sessions.findMany()).length, 1);
      const replay = await (await post(request)).json();
      equal(replay.errors, undefined);
      equal(replay.data.completeLoginChallenge, null);
    });
  });

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

      const { challengeId } = loginBody.data.loginByEmail;
      equal(typeof challengeId, "string");

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
      equal(loginUrl.searchParams.get("challengeId"), challengeId);

      const code = loginUrl.searchParams.get("code");
      ok(code);

      const completeResponse = await post({
        query: completeLoginMutation,
        variables: { challengeId, code },
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
