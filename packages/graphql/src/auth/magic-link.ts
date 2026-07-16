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

import builder, { type UserContext } from "../builder.ts";
import { generateBase36Code, hashSecret } from "./hash.ts";
import { logReceipt, sendMail } from "./mail.ts";

interface SendMailShape {
  readonly token: string;
}

const SendMailRef = builder.objectRef<SendMailShape>("SendMail").implement({
  description: "The mail sent.",
  fields: (t) => ({
    token: t.expose("token", {
      type: "UUID",
      description: "Token for login.",
    }),
  }),
});

builder.mutationFields((t) => ({
  loginByEmail: t.field({
    type: SendMailRef,
    description: "Send a magic link to email. Always returns `token: UUID`.",
    args: {
      email: t.arg({
        type: "Email",
        required: true,
        description: "The email address of the `Account`.",
      }),
      verifyUrl: t.arg({
        type: "String",
        required: false,
        description:
          "The URL's origin must be in the server's allowlist. " +
          "When omitted, the email carries the raw token and code.",
      }),
    },
    async resolve(_root, { email, verifyUrl }, ctx) {
      const token = crypto.randomUUID();
      const account = await findAccount(email, ctx);
      if (account == null) {
        // Returned token even if the account does not exist to prevent account
        // enumeration. Consider mailing in a worker to prevent timing attacks.
        return { token };
      }
      const verifier = {
        token,
        template: verifyUrl,
        code: generateBase36Code(CODE_LEN),
      };

      await insertToken(account.id, verifier, ctx);
      // Do not check the email was sent. Instructs users to request a resend if
      // the email does not arrive after a few minutes at the web page.
      logReceipt(await sendMail(account.email, verifier, ctx));

      return { token };
    },
  }),
}));

const CODE_LEN = 6;

const findAccount = async (email: string, ctx: UserContext) =>
  await ctx.db.query.accounts.findFirst({
    where: { email },
  });

const insertToken = async (
  accountId: string,
  { token, code }: { token: string; code: string },
  ctx: UserContext,
) =>
  await ctx.db.insert(schema.loginTokens).values({
    id: crypto.randomUUID(),
    accountId,
    tokenHash: await hashSecret(token),
    codeHash: await hashSecret(code),
  });
