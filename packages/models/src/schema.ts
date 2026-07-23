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
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * The database table to represent accounts.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey(),
    email: varchar({ length: 255 }).notNull().unique(),
    name: varchar({ length: 100 }).notNull(),
    maxInstances: integer("max_instances").notNull().default(10),
    admin: boolean().notNull().default(false),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "accounts_email_check",
      sql`${table.email} ~ '^[^@]+@[^@]+\\.[^@]+$'`,
    ),
    check("accounts_max_instances_check", sql`${table.maxInstances} >= 0`),
    check("accounts_name_check", sql`trim(both from ${table.name}) <> ''`),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

/**
 * The database table to represent instances.
 */
export const instances = pgTable(
  "instances",
  {
    id: uuid().primaryKey(),
    slug: varchar({ length: 100 }).notNull().unique(),
    expires: timestamp({ withTimezone: true }).notNull(),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("instances_slug_check", sql`${table.slug} ~ '^[a-z0-9-]{4,100}$'`),
    check(
      "instances_expires_check",
      sql`${table.expires} < (${table.created} + INTERVAL '1 year')`,
    ),
  ],
);

export type Instance = typeof instances.$inferSelect;
export type NewInstance = typeof instances.$inferInsert;

/**
 * The association table between instances and its member accounts.
 * Note that it also contains the just invited members, which are not yet
 * accepted.  The `accepted` field is `NULL` for those members.
 */
export const instanceMembers = pgTable(
  "instance_members",
  {
    accountId: uuid()
      .notNull()
      .references(() => accounts.id),
    instanceId: uuid()
      .notNull()
      .references(() => instances.id),
    admin: boolean().notNull().default(false),
    accepted: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.instanceId, table.accountId] }),
    index()
      .on(table.accountId)
      .where(sql`${table.accepted} IS NOT NULL`),
    index()
      .on(table.instanceId)
      .where(sql`${table.accepted} IS NOT NULL`),
  ],
);

export type InstanceMember = typeof instanceMembers.$inferSelect;
export type NewInstanceMember = typeof instanceMembers.$inferInsert;

/**
 * Tokens for email login. `tokenHash` and `codeHash` store SHA-256 hex digests,
 * not the raw secrets.  The `tokenHash` field is used for lookup and
 * the `codeHash` field is the hash of the raw code that is sent to the user's
 * email.
 */
export const loginTokens = pgTable("login_tokens", {
  id: uuid().primaryKey(),
  accountId: uuid()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  tokenHash: varchar({ length: 64 }).notNull().unique(),
  codeHash: varchar({ length: 64 }).notNull(),
  created: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  expires: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP + INTERVAL '15 minutes'`),
  consumed: timestamp({ withTimezone: true }),
});

export type LoginToken = typeof loginTokens.$inferSelect;
export type NewLoginToken = typeof loginTokens.$inferInsert;

/**
 * Authenticated sessions. The `id` field is used to revoke a session, and
 * the `tokenHash` is the hash of the bearer access token.
 */
export const sessions = pgTable("sessions", {
  id: uuid().primaryKey(),
  accountId: uuid()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  tokenHash: varchar({ length: 64 }).notNull().unique(),
  created: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  expires: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP + INTERVAL '1 month'`),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
