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

// oxlint-disable no-magic-numbers

import { schema } from "@drfed/models";
import { type Uuid, uuidV7 } from "@drfed/models/uuid";

import builder, { type UserContext } from "../builder.ts";
import { generateBase36Code } from "./hash.ts";
import { logReceipt, sendMail } from "./mail.ts";

interface LoginChallengeShape {
  readonly challengeId: Uuid;
}

const LoginChallengeRef = builder
  .objectRef<LoginChallengeShape>("LoginChallenge")
  .implement({
    description: "An email login challenge.",
    fields: (t) => ({
      challengeId: t.expose("challengeId", {
        type: "UUID",
        description: "The public identifier of the login challenge.",
      }),
    }),
  });

builder.mutationFields((t) => ({
  loginByEmail: t.field({
    type: LoginChallengeRef,
    description:
      "Send a magic link to email. Always returns `challengeId: UUID`.",
    args: {
      email: t.arg({
        type: "Email",
        required: true,
        description: "The email address of the `Account`.",
      }),
      verifyUrl: t.arg({
        type: "URITemplate",
        required: false,
        description:
          "Use {challengeId} and {code} variables. " +
          "The URL's origin must be in the server's allowlist. " +
          "When omitted, the email carries the challenge ID and verification code.",
      }),
    },
    async resolve(_root, { email, verifyUrl }, ctx) {
      const challengeId = uuidV7();
      const account = await findAccount(email, ctx);
      if (account == null) {
        // Return an ID even for an unknown account to prevent account
        // enumeration. Consider mailing in a worker to prevent timing attacks.
        return { challengeId };
      }
      const verifier = {
        challengeId,
        template: verifyUrl,
        code: generateBase36Code(schema.LOGIN_CHALLENGE_CODE_LENGTH),
      };

      await insertChallenge(account.id, verifier, ctx);
      // Do not check the email was sent. Instructs users to request a resend if
      // the email does not arrive after a few minutes at the web page.
      logReceipt(await sendMail(account.email, verifier, ctx));

      return { challengeId };
    },
  }),
}));

const findAccount = async (email: string, ctx: UserContext) =>
  await ctx.db.query.accounts.findFirst({
    where: { email },
  });

const insertChallenge = async (
  accountId: Uuid,
  { challengeId, code }: { challengeId: Uuid; code: string },
  ctx: UserContext,
) =>
  await ctx.db.insert(schema.loginChallenges).values({
    id: challengeId,
    accountId,
    code,
  });
