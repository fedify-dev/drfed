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

import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import type { Database } from "@drfed/models";
import {
  LoginChallengeError,
  consumeLoginChallenge,
  findLoginChallenge,
} from "@drfed/models/login";
import { sessions } from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";

import builder from "../builder.ts";
import { generateAccessToken, hashSecret } from "./hash.ts";

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
    // The only `Session` a client can obtain is the one `completeLoginChallenge`
    // just created for it, and `Session` is not a `Node`, so the account behind
    // a session is always the viewer's own.  Granting `ownAccount` here lets
    // the login response carry the viewer's private fields even though the
    // request that produced it had no session yet.
    account: t.relation("account", { grantScopes: ["ownAccount"] }),
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
      challengeId: t.arg({ type: "UUID", required: true }),
      code: t.arg({ type: "String", required: true }),
    },
    async resolve(query, _root, { challengeId, code }, ctx) {
      try {
        const now = new Date();
        const row = await findLoginChallenge(ctx.db, challengeId, now);
        const id = crypto.randomUUID();
        const accessToken = generateAccessToken();
        const accessHash = await hashSecret(accessToken);

        const providedCode = Buffer.from(code.toLowerCase());
        const expectedCode = Buffer.from(row.code);
        if (
          providedCode.length !== expectedCode.length ||
          !timingSafeEqual(providedCode, expectedCode)
        ) {
          throw new LoginChallengeError("The provided code does not match.");
        }
        await ctx.db.transaction(async (tx) => {
          await consumeLoginChallenge(tx, row.id, now);
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

const insertSession = async (
  id: Uuid,
  accountId: Uuid,
  tokenHash: string,
  tx: Database,
) => await tx.insert(sessions).values({ id, accountId, tokenHash });
