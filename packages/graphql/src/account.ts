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
import builder from "./builder.ts";

export const Account = builder.drizzleNode("accounts", {
  name: "Account",
  id: {
    column(account) {
      return account.id;
    },
    description: "The unique identifier of the `Account`.",
  },
  fields: (t) => ({
    uuid: t.expose("id", {
      type: "UUID",
      description: "The UUID of the `Account`.",
    }),
    email: t.expose("email", {
      type: "Email",
      description: "The email address of the `Account`.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "The date/time when the `Account` was created.",
    }),
  }),
});

builder.queryFields((t) => ({
  accountByUuid: t.drizzleField({
    type: Account,
    description: "Get an `Account` by its UUID.",
    args: {
      uuid: t.arg({
        type: "UUID",
        required: true,
        description: "The UUID of the `Account` to retrieve.",
      }),
    },
    nullable: true,
    resolve(query, _, { uuid }, ctx) {
      return ctx.db.query.accounts.findFirst(query({ where: { id: uuid } }));
    },
  }),
}));
