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
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const currentTimestamp = sql`CURRENT_TIMESTAMP`;

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
      .default(currentTimestamp),
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
export const instances = pgTable("instances", {
  id: uuid().primaryKey(),
  localId: uuid().references(() => localInstances.id, {
    onDelete: "cascade",
  }),
  created: timestamp({ withTimezone: true })
    .notNull()
    .default(currentTimestamp),
  host: varchar({ length: 100 }).notNull().unique(),
  nodeInfoUrl: text(),
  software: text(),
  softwareVersion: text(),
});

export type Instance = typeof instances.$inferSelect;
export type NewInstance = typeof instances.$inferInsert;

export const localInstances = pgTable(
  "local_instances",
  {
    id: uuid().primaryKey(),
    slug: varchar({ length: 63 }).notNull().unique(),
    expires: timestamp({ withTimezone: true }).notNull(),
    maxActors: integer().notNull().default(10),
  },
  (table) => [
    check("instances_slug_check", sql`${table.slug} ~ '^[a-z0-9-]{4,63}$'`),
    check("instances_max_actors_check", sql`${table.maxActors} > 0`),
  ],
);

export type LocalInstance = typeof localInstances.$inferSelect;
export type NewLocalInstance = typeof localInstances.$inferInsert;

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
      .default(currentTimestamp),
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
    .default(currentTimestamp),
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
    .default(currentTimestamp),
  expires: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP + INTERVAL '1 month'`),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export const actorTypeEnum = pgEnum("actor_type", [
  "Application",
  "Group",
  "Organization",
  "Person",
  "Service",
]);

export type ActorType = (typeof actorTypeEnum.enumValues)[number];

export const actors = pgTable(
  "actors",
  {
    id: uuid().primaryKey(),
    location: locationEnum().notNull(),
    type: actorTypeEnum().notNull(),
    username: text().notNull(),
    instanceId: uuid()
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    name: text(),
    bioHtml: text(),
    automaticallyApprovesFollowers: boolean().notNull().default(false),
    fieldHtmls: jsonb().$type<Record<string, string>>().notNull().default({}),
    emojis: jsonb().$type<Record<string, string>>().notNull().default({}),
    tags: jsonb().$type<Record<string, string>>().notNull().default({}),
    sensitive: boolean().notNull().default(false),
    // Moderation sanction state, denormalized from flag_action records
    // (which remain the audit source of truth):
    // - Not sanctioned: suspended IS NULL
    // - Temporary suspension: suspended = start, suspendedUntil = end
    // - Permanent suspension (ban) for local actors, or permanent federation
    //   block for remote actors: suspended set, suspendedUntil IS NULL
    // Whether a sanction is *currently* active is always determined by
    // comparing against the current time (lazy expiry; no cron):
    // suspended <= now AND (suspendedUntil IS NULL OR suspendedUntil > now).
    suspended: timestamp({ withTimezone: true }),
    suspendedUntil: timestamp({ withTimezone: true }),
    successorId: uuid().references((): AnyPgColumn => actors.id, {
      onDelete: "set null",
    }),
    aliases: text()
      .array()
      .notNull()
      .default(sql`(ARRAY[]::text[])`),
    followeesCount: integer().notNull().default(0),
    followersCount: integer().notNull().default(0),
    postsCount: integer().notNull().default(0),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp)
      .$onUpdate(() => currentTimestamp),
    published: timestamp({ withTimezone: true }),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    deleted: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique("username_key").on(t.username, t.instanceId),
    check("actors_username_check", sql`${t.username} NOT LIKE '%@%'`),
    check(
      "actors_suspended_check",
      sql`
        ${t.suspendedUntil} IS NULL OR (
          ${t.suspended} IS NOT NULL AND
          ${t.suspendedUntil} > ${t.suspended}
        )
      `,
    ),
    index("actor_instance_index").on(t.instanceId),
    unique("actors_id_location_key").on(t.id, t.location),
  ],
);

export type Actor = typeof actors.$inferSelect;
export type NewActor = typeof actors.$inferInsert;

export const localActors = pgTable(
  "local_actors",
  {
    id: uuid()
      .primaryKey()
      .references(() => actors.id, { onDelete: "cascade" }),
    avatar: text(),
    header: text(),
    /**
     * This `location` column is not an actually used value;
     * it exists to prevent simultaneous Local/Remote registration,
     * so it must be fixed as `Local`.
     */
    location: locationEnum().default("Local").notNull(),
  },
  (t) => [
    check("local_check", sql`${t.location} = 'Local'`),
    foreignKey({
      name: "local_actor_fk",
      columns: [t.id, t.location],
      foreignColumns: [actors.id, actors.location],
    }).onDelete("cascade"),
  ],
);

export type LocalActor = typeof localActors.$inferSelect;
export type NewLocalActor = typeof localActors.$inferInsert;

export const remoteActors = pgTable(
  "remote_actors",
  {
    id: uuid()
      .primaryKey()
      .references(() => actors.id, { onDelete: "cascade" }),
    iriUrl: text().notNull().unique(),
    inboxUrl: text().notNull(),
    outboxUrl: text().notNull(),
    followersUrl: text(),
    followeesUrl: text(),
    featuredUrl: text(),
    profileUrl: text(),
    avatarUrl: text(),
    headerUrl: text(),
    /**
     * This `location` column is not an actually used value;
     * it exists to prevent simultaneous Local/Remote registration,
     * so it must be fixed as `Remote`.
     */
    location: locationEnum().default("Remote").notNull(),
  },
  (t) => [
    check("remote_check", sql`${t.location} = 'Remote'`),
    foreignKey({
      name: "remote_actor_fk",
      columns: [t.id, t.location],
      foreignColumns: [actors.id, actors.location],
    }).onDelete("cascade"),
  ],
);

export type RemoteActor = typeof remoteActors.$inferSelect;
export type NewRemoteActor = typeof remoteActors.$inferInsert;
