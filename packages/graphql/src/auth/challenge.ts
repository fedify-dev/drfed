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

import type { Database } from "@drfed/models";
import { loginTokens, sessions } from "@drfed/models/schema";
import { and, eq, gt, isNull } from "drizzle-orm/sql/expressions";

import builder, { type UserContext } from "../builder.ts";
import { LoginChallengeError } from "./errors.ts";
import { equalSecretHashes, generateAccessToken, hashSecret } from "./hash.ts";

const SessionRef = builder.drizzleObject("sessions", {
  name: "Session",
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    accessToken: t.string({
      nullable: true,
      resolve(session) {
        const accessToken =
          "accessToken" in session ? session.accessToken : null;
        return typeof accessToken === "string" ? accessToken : null;
      },
    }),
    account: t.relation("account"),
    created: t.expose("created", { type: "DateTime" }),
    expires: t.expose("expires", { type: "DateTime" }),
  }),
});

builder.mutationFields((t) => ({
  completeLoginChallenge: t.drizzleField({
    type: SessionRef,
    nullable: true,
    description: "Complete login challenge.",
    args: {
      token: t.arg({ type: "UUID", required: true }),
      code: t.arg({ type: "String", required: true }),
    },
    async resolve(query, _root, { token, code }, ctx) {
      try {
        const tokenHash = await hashSecret(token.toLowerCase());
        const now = new Date(Temporal.Now.instant().toString());
        const row = await findToken(tokenHash, now, ctx);
        const id = crypto.randomUUID();
        const accessToken = generateAccessToken();
        const accessHash = await hashSecret(accessToken);

        await verifyCode(code, row.codeHash);
        await ctx.db.transaction(async (tx) => {
          await consumeToken(row.id, now, tx);
          await insertSession(id, row.accountId, accessHash, tx);
        });

        const session = await ctx.db.query.sessions.findFirst(
          query({ where: { id } }),
        );
        return session == null ? null : { ...session, accessToken };
      } catch (error) {
        if (error instanceof LoginChallengeError) {
          return null;
        }
        throw error;
      }
    },
  }),
}));

const findToken = async (tokenHash: string, now: Date, ctx: UserContext) =>
  (await ctx.db.query.loginTokens.findFirst({
    where: { tokenHash, expires: { gt: now }, consumed: { isNull: true } },
  })) ??
  new LoginChallengeError(
    `Can't find an alive login token: ${tokenHash}.`,
  ).throw();

const verifyCode = async (userCode: string, dbCodeHash: string) =>
  (await equalSecretHashes(
    await hashSecret(userCode.toLowerCase()),
    dbCodeHash,
  )) ||
  new LoginChallengeError(`The user's code and DB's one don't match`).throw();

const consumeToken = async (tokenId: string, now: Date, tx: Database) =>
  (
    await tx
      .update(loginTokens)
      .set({ consumed: now })
      .where(
        and(
          eq(loginTokens.id, tokenId),
          isNull(loginTokens.consumed),
          gt(loginTokens.expires, now),
        ),
      )
      .returning({ consumed: loginTokens.consumed })
  )[0]?.consumed ??
  new LoginChallengeError("Updating `consumed` failed.").throw();

const insertSession = async (
  id: string,
  accountId: string,
  tokenHash: string,
  tx: Database,
) => await tx.insert(sessions).values({ id, accountId, tokenHash });
