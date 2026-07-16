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

import { sessions } from "@drfed/models/schema";
import { and, eq } from "drizzle-orm/sql/expressions";

import builder, { type UserContext } from "../builder.ts";

builder.mutationFields((t) => ({
  revokeSession: t.field({
    type: LogoutSuccessRef,
    description: "Revokes a session. Return always `revoke: true`.",
    args: {
      session: t.arg({
        type: "UUID",
        required: true,
        description: "The session ID to revoke.",
      }),
    },
    async resolve(_query, { session }, ctx) {
      if (ctx.session != null) {
        await deleteSession(session, ctx);
      }
      // Return always true to prevent brute-force attack.
      return { revoke: true };
    },
  }),
}));

interface LogoutSuccessShape {
  revoke: boolean;
}

const LogoutSuccessRef = builder
  .objectRef<LogoutSuccessShape>("LogoutSuccess")
  .implement({
    description: "The session revoked.",
    fields: (t) => ({
      revoke: t.expose("revoke", {
        type: "Boolean",
        description: "Revoking status.",
      }),
    }),
  });

const deleteSession = (id: string, ctx: UserContext) =>
  ctx.db
    .delete(sessions)
    .where(
      and(eq(sessions.id, id), eq(sessions.accountId, ctx.session!.accountId)),
    );
