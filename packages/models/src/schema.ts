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

import { desc, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type { Uuid } from "./uuid.ts";

const currentTimestamp = sql`CURRENT_TIMESTAMP`;

/**
 * The database table to represent accounts.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid().$type<Uuid>().primaryKey(),
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
  id: uuid().$type<Uuid>().primaryKey(),
  localId: uuid()
    .$type<Uuid>()
    .references(() => localInstances.id, {
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
    id: uuid().$type<Uuid>().primaryKey(),
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
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id),
    instanceId: uuid()
      .$type<Uuid>()
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

/** The length of an email login verification code. */
export const LOGIN_CHALLENGE_CODE_LENGTH = 6;

/**
 * Email login challenges identified by a public UUID and verified by a
 * plaintext code. Each challenge expires after 15 minutes and is single-use.
 */
export const loginChallenges = pgTable("login_challenges", {
  id: uuid().$type<Uuid>().primaryKey(),
  accountId: uuid()
    .$type<Uuid>()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  code: char({ length: LOGIN_CHALLENGE_CODE_LENGTH }).notNull(),
  created: timestamp({ withTimezone: true })
    .notNull()
    .default(currentTimestamp),
  expires: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP + INTERVAL '15 minutes'`),
  consumed: timestamp({ withTimezone: true }),
});

export type LoginChallenge = typeof loginChallenges.$inferSelect;
export type NewLoginChallenge = typeof loginChallenges.$inferInsert;

/**
 * Authenticated sessions. The `id` field is used to revoke a session, and
 * the `tokenHash` is the hash of the bearer access token.
 */
export const sessions = pgTable("sessions", {
  id: uuid().$type<Uuid>().primaryKey(),
  accountId: uuid()
    .$type<Uuid>()
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
    id: uuid().$type<Uuid>().primaryKey(),
    localId: uuid()
      .$type<Uuid>()
      .unique()
      .references(() => localActors.id, { onDelete: "cascade" }),
    type: actorTypeEnum().notNull(),
    username: text().notNull(),
    instanceId: uuid()
      .$type<Uuid>()
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    iri: text().notNull().unique(),
    inboxUrl: text().notNull(),
    outboxUrl: text().notNull(),
    followersUrl: text(),
    followingUrl: text(),
    featuredUrl: text(),
    profileUrl: text(),
    avatarUrl: text(),
    headerUrl: text(),
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
    successorId: uuid()
      .$type<Uuid>()
      .references((): AnyPgColumn => actors.id, {
        onDelete: "set null",
      }),
    aliases: text()
      .array()
      .notNull()
      .default(sql`(ARRAY[]::text[])`),
    followingCount: integer().notNull().default(0),
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
  ],
);

export type Actor = typeof actors.$inferSelect;
export type NewActor = typeof actors.$inferInsert;

export const localActors = pgTable("local_actors", {
  id: uuid().$type<Uuid>().primaryKey(),
  avatar: text(),
  header: text(),
});

export type LocalActor = typeof localActors.$inferSelect;
export type NewLocalActor = typeof localActors.$inferInsert;

export const objectTypeEnum = pgEnum("object_type", ["Article", "Note"]);
export type ObjectType = (typeof objectTypeEnum.enumValues)[number];
export const objectVisibilityEnum = pgEnum("object_visibility", [
  "public",
  "unlisted",
  "followers",
]);
export type ObjectVisibility = (typeof objectVisibilityEnum.enumValues)[number];

/** ActivityPub objects authored by actors. */
export const objects = pgTable(
  "objects",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    actorId: uuid()
      .$type<Uuid>()
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    type: objectTypeEnum().notNull(),
    iri: text().notNull().unique(),
    url: text(),
    visibility: objectVisibilityEnum().notNull().default("public"),
    name: text(),
    summary: text(),
    contentHtml: text().notNull(),
    language: varchar({ length: 35 }),
    sensitive: boolean().notNull().default(false),
    published: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    updated: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp)
      .$onUpdate(() => currentTimestamp),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(currentTimestamp),
    deleted: timestamp({ withTimezone: true }),
  },
  (t) => [
    check(
      "objects_content_html_check",
      sql`trim(both from ${t.contentHtml}) <> ''`,
    ),
    index("object_actor_published_index").on(
      t.actorId,
      desc(t.published),
      desc(t.id),
    ),
  ],
);
export type ActivityPubObject = typeof objects.$inferSelect;
export type NewActivityPubObject = typeof objects.$inferInsert;
