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

import type { webcrypto } from "node:crypto";

import { desc, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  bytea,
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type { PublicJwk } from "./key.ts";
import type { Uuid } from "./uuid.ts";

/** A timestamptz column preserving PostgreSQL's microsecond precision. */
const instant = customType<{ data: Temporal.Instant; driverData: string }>({
  dataType: () => "timestamp with time zone",
  fromDriver: (value) => Temporal.Instant.from(value),
  toDriver(value: Temporal.Instant | string) {
    // Pothos composite cursors decode timestamps as strings.
    if (typeof value === "string") return value;
    if (value instanceof Temporal.Instant) return value.toString();
    throw new TypeError(
      "Expected a Temporal.Instant or a cursor timestamp string.",
    );
  },
});

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
    created: instant().notNull().default(currentTimestamp),
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
  localId: uuid("local_id")
    .$type<Uuid>()
    .references(() => localInstances.id, {
      onDelete: "cascade",
    }),
  created: instant().notNull().default(currentTimestamp),
  // The authority an instance is federated under, which is what Fedify's
  // `Context.host` reports and therefore what dispatchers look instances up
  // by.  That is a DNS name, at most 253 octets, plus a `:port` suffix of up
  // to 6 more characters when the deployment is not on the scheme's default
  // port.  Both locally composed `<slug>.<root domain>` names and remote
  // hosts discovered from the fediverse live here.
  host: varchar({ length: 259 }).notNull().unique(),
  nodeInfoUrl: text("node_info_url"),
  software: text(),
  softwareVersion: text("software_version"),
});

export type Instance = typeof instances.$inferSelect;
export type NewInstance = typeof instances.$inferInsert;

export const localInstances = pgTable(
  "local_instances",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    slug: varchar({ length: 63 }).notNull().unique(),
    expires: instant().notNull(),
    maxActors: integer("max_actors").notNull().default(10),
  },
  (table) => [
    // Keep this in agreement with `isValidSlug()` in ./slug.ts.  A slug
    // becomes the leftmost label of the instance's host name, so it has to be
    // a valid DNS label: no leading or trailing hyphen, and none of RFC 5891's
    // reserved LDH labels except the `xn--` prefix of an A-label, which stays
    // allowed so that instances can carry internationalized domain names.
    check(
      "local_instances_slug_check",
      sql`${table.slug} ~ '^[a-z0-9][a-z0-9-]{2,61}[a-z0-9]$'
        AND (${table.slug} !~ '^..--' OR ${table.slug} ~ '^xn--')`,
    ),
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
    accountId: uuid("account_id")
      .$type<Uuid>()
      .notNull()
      .references(() => accounts.id),
    instanceId: uuid("instance_id")
      .$type<Uuid>()
      .notNull()
      .references(() => instances.id),
    admin: boolean().notNull().default(false),
    accepted: instant(),
    created: instant().notNull().default(currentTimestamp),
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
  accountId: uuid("account_id")
    .$type<Uuid>()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  code: char({ length: LOGIN_CHALLENGE_CODE_LENGTH }).notNull(),
  created: instant().notNull().default(currentTimestamp),
  expires: instant()
    .notNull()
    .default(sql`CURRENT_TIMESTAMP + INTERVAL '15 minutes'`),
  consumed: instant(),
});

export type LoginChallenge = typeof loginChallenges.$inferSelect;
export type NewLoginChallenge = typeof loginChallenges.$inferInsert;

/**
 * Authenticated sessions. The `id` field is used to revoke a session, and
 * the `tokenHash` is the hash of the bearer access token.
 */
export const sessions = pgTable("sessions", {
  id: uuid().$type<Uuid>().primaryKey(),
  accountId: uuid("account_id")
    .$type<Uuid>()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
  created: instant().notNull().default(currentTimestamp),
  expires: instant()
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

export const resourceKindEnum = pgEnum("resource_kind", [
  "actor",
  "object",
  "activity",
  "collection",
  "unknown",
]);

/**
 * Canonical IRI registry. Physical deletion of an actor, object, activity or
 * collection must also delete its source addressing and resource in the same
 * transaction. References from other resources intentionally restrict deletion.
 */
export const resources = pgTable("resources", {
  id: uuid().$type<Uuid>().primaryKey(),
  iri: text().notNull().unique(),
  kind: resourceKindEnum().notNull(),
  created: instant().notNull().default(currentTimestamp),
});
export type Resource = typeof resources.$inferSelect;

export const actors = pgTable(
  "actors",
  {
    id: uuid()
      .$type<Uuid>()
      .primaryKey()
      .references(() => resources.id, { onDelete: "cascade" }),
    localId: uuid("local_id")
      .$type<Uuid>()
      .unique()
      .references(() => localActors.id, { onDelete: "cascade" }),
    type: actorTypeEnum().notNull(),
    /**
     * A local actor's handle username; a remote actor's `preferredUsername`
     * as received, which ActivityPub neither requires nor makes unique.
     */
    username: text(),
    instanceId: uuid("instance_id")
      .$type<Uuid>()
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    document: json(),
    inboxUrl: text("inbox_url").notNull(),
    profileUrl: text("profile_url"),
    avatarUrl: text("avatar_url"),
    headerUrl: text("header_url"),
    name: text(),
    bioHtml: text("bio_html"),
    automaticallyApprovesFollowers: boolean("automatically_approves_followers")
      .notNull()
      .default(false),
    fieldHtmls: jsonb("field_htmls")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
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
    // Temporal.Instant.compare(suspended, now) <= 0 AND (suspendedUntil IS NULL OR Temporal.Instant.compare(suspendedUntil, now) > 0).
    suspended: instant(),
    suspendedUntil: instant("suspended_until"),
    successorId: uuid("successor_id")
      .$type<Uuid>()
      .references((): AnyPgColumn => actors.id, {
        onDelete: "set null",
      }),
    aliases: text()
      .array()
      .notNull()
      .default(sql`(ARRAY[]::text[])`),
    followingCount: integer("following_count").notNull().default(0),
    followersCount: integer("followers_count").notNull().default(0),
    updated: instant()
      .notNull()
      .default(currentTimestamp)
      .$onUpdate(() => currentTimestamp),
    published: instant(),
    created: instant().notNull().default(currentTimestamp),
    // When implementing actor deletion, add activities.deleted and set it
    // together with objects.deleted in the same transaction.
    // FIXME: https://github.com/fedify-dev/drfed/issues/89
    deleted: instant(),
  },
  (t) => [
    uniqueIndex("username_key")
      .on(t.username, t.instanceId)
      .where(sql`${t.localId} IS NOT NULL`),
    check(
      "actors_username_check",
      sql`${t.localId} IS NULL OR ${t.username} NOT LIKE '%@%'`,
    ),
    check(
      "actors_local_username_check",
      sql`${t.localId} IS NULL OR ${t.username} IS NOT NULL`,
    ),
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

/** Signing algorithms available to local actors. */
export const localActorKeyTypeEnum = pgEnum("local_actor_key_type", [
  "RSASSA-PKCS1-v1_5",
  "Ed25519",
]);
export type LocalActorKeyType =
  (typeof localActorKeyTypeEnum.enumValues)[number];
/** Private signing material; never expose this table through GraphQL. */
export const localActorKeys = pgTable(
  "local_actor_keys",
  {
    localActorId: uuid("local_actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => localActors.id, { onDelete: "cascade" }),
    type: localActorKeyTypeEnum().notNull(),
    publicKey: jsonb("public_key").$type<PublicJwk>().notNull(),
    privateKey: jsonb("private_key").$type<webcrypto.JsonWebKey>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.localActorId, table.type] }),
    check(
      "local_actor_keys_public_key_check",
      sql`jsonb_typeof(${table.publicKey}) = 'object' AND NOT (${table.publicKey} ?| array['d','p','q','dp','dq','qi','oth','k'])`,
    ),
  ],
);
export type LocalActorKey = typeof localActorKeys.$inferSelect;
export type NewLocalActorKey = typeof localActorKeys.$inferInsert;

export const objectTypeEnum = pgEnum("object_type", ["Article", "Note"]);
export type ObjectType = (typeof objectTypeEnum.enumValues)[number];
/** ActivityPub objects authored by actors. */
export const objects = pgTable(
  "objects",
  {
    id: uuid()
      .$type<Uuid>()
      .primaryKey()
      .references(() => resources.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    type: objectTypeEnum().notNull(),
    document: json(),
    url: text(),
    name: text(),
    summary: text(),
    contentHtml: text("content_html").notNull(),
    language: varchar({ length: 35 }),
    sensitive: boolean().notNull().default(false),
    published: instant().notNull().default(currentTimestamp),
    updated: instant()
      .notNull()
      .default(currentTimestamp)
      .$onUpdate(() => currentTimestamp),
    created: instant().notNull().default(currentTimestamp),
    deleted: instant(),
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

export const collectionTypeEnum = pgEnum("collection_type", [
  "Collection",
  "OrderedCollection",
]);
export const collectionRoleEnum = pgEnum("collection_role", [
  "followers",
  "following",
  "featured",
  "outbox",
]);
export type CollectionRole = (typeof collectionRoleEnum.enumValues)[number];
export const collections = pgTable("collections", {
  id: uuid()
    .$type<Uuid>()
    .primaryKey()
    .references(() => resources.id, { onDelete: "cascade" }),
  type: collectionTypeEnum().notNull(),
  /**
   * Lifecycle owner of a locally managed collection. Physical deletion of
   * the owner cascades to the collection and all references. Soft deletion
   * hides the collection and every actor's reference to it from GraphQL.
   */
  ownerActorId: uuid("owner_actor_id")
    .$type<Uuid>()
    .references(() => actors.id, { onDelete: "cascade" }),
  totalItems: integer("total_items"),
  document: json(),
  updated: instant()
    .notNull()
    .default(currentTimestamp)
    .$onUpdate(() => currentTimestamp),
});
export type Collection = typeof collections.$inferSelect;

/** Actor-declared collection roles; a collection may be shared across roles or actors. */
export const actorCollectionReferences = pgTable(
  "actor_collection_references",
  {
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    role: collectionRoleEnum().notNull(),
    collectionId: uuid("collection_id")
      .$type<Uuid>()
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.actorId, t.role] }),
    index("actor_collection_reference_collection_index").on(t.collectionId),
  ],
);

export const collectionItems = pgTable(
  "collection_items",
  {
    collectionId: uuid("collection_id")
      .$type<Uuid>()
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .$type<Uuid>()
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    position: integer(),
    observed: instant().notNull().default(currentTimestamp),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.itemId] }),
    index("collection_item_position_index").on(t.collectionId, t.position),
  ],
);

export const activityTypeEnum = pgEnum("activity_type", ["Create"]);
export const activities = pgTable(
  "activities",
  {
    id: uuid()
      .$type<Uuid>()
      .primaryKey()
      .references(() => resources.id, { onDelete: "cascade" }),
    type: activityTypeEnum().notNull(),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .$type<Uuid>()
      .references(() => resources.id, { onDelete: "cascade" }),
    published: instant().notNull(),
    document: json(),
    created: instant().notNull().default(currentTimestamp),
  },
  (t) => [
    index("activity_actor_published_index").on(
      t.actorId,
      desc(t.published),
      desc(t.id),
    ),
    index("activity_object_published_index").on(t.objectId, t.published, t.id),
  ],
);
export type StoredActivity = typeof activities.$inferSelect;

export const addressingPropertyEnum = pgEnum("addressing_property", [
  "to",
  "cc",
  "bto",
  "bcc",
  "audience",
]);
export type AddressingProperty =
  (typeof addressingPropertyEnum.enumValues)[number];
export const addressing = pgTable(
  "addressing",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    sourceId: uuid("source_id")
      .$type<Uuid>()
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    property: addressingPropertyEnum().notNull(),
    position: integer().notNull(),
    targetId: uuid("target_id")
      .$type<Uuid>()
      .notNull()
      .references(() => resources.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("addressing_source_property_position_key").on(
      t.sourceId,
      t.property,
      t.position,
    ),
    index("addressing_target_property_index").on(t.targetId, t.property),
  ],
);
export type Addressing = typeof addressing.$inferSelect;

/** Direction of an observed delivery. */
export const activityDeliveryDirectionEnum = pgEnum(
  "activity_delivery_direction",
  ["inbound", "outbound"],
);

/**
 * Inbound: `received` (2xx, listener ran), `acknowledged` (2xx, listener did
 * not run), `unverified`, `rejected` (refused although verified); a request
 * whose handling threw is one of the last two, without a status code.  Outbound:
 * `queued` (no attempt ended yet), `sent`, `failed` (the latest attempt
 * failed; a queued delivery may be retried), `permanently_failed`,
 * `abandoned` (the retry policy ran out).
 */
export const activityDeliveryStatusEnum = pgEnum("activity_delivery_status", [
  "received",
  "acknowledged",
  "unverified",
  "rejected",
  "queued",
  "sent",
  "failed",
  "permanently_failed",
  "abandoned",
]);

/** The mechanism that authenticated an inbound activity. */
export const activityDeliveryVerificationMechanismEnum = pgEnum(
  "activity_delivery_verification_mechanism",
  ["http_signature", "ld_signature", "object_integrity_proof"],
);

/**
 * What Fedify reported of an inbound verification; `unattempted` when it
 * answered before verifying, and `unobserved` when recording failed.
 */
export const activityDeliveryVerificationResultEnum = pgEnum(
  "activity_delivery_verification_result",
  [
    "verified",
    "invalid_signature",
    "key_fetch_error",
    "no_signature",
    "unattempted",
    "unobserved",
  ],
);

/** Logical public keys, identified by their exact IRI. */
export const keys = pgTable("keys", {
  id: uuid().$type<Uuid>().primaryKey(),
  iri: text().notNull().unique(),
  created: instant().notNull().default(currentTimestamp),
});

/** Immutable key material, independently retained from Fedify's KV cache. */
export const keyVersions = pgTable(
  "key_versions",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    keyId: uuid("key_id")
      .$type<Uuid>()
      .notNull()
      .references(() => keys.id, { onDelete: "restrict" }),
    publicKey: jsonb("public_key").$type<PublicJwk>().notNull(),
    fingerprint: text().notNull(),
    /** DrFed observation time, not remote rotation time or evidence of continuous use. */
    firstSeen: instant("first_seen").notNull(),
    /** DrFed observation time, not remote rotation time or evidence of continuous use. */
    lastSeen: instant("last_seen").notNull(),
  },
  (table) => [
    unique("key_versions_key_id_fingerprint_unique").on(
      table.keyId,
      table.fingerprint,
    ),
    check(
      "key_versions_seen_check",
      sql`${table.lastSeen} >= ${table.firstSeen}`,
    ),
    check(
      "key_versions_public_key_check",
      sql`NOT (${table.publicKey} ?| array['d','p','q','dp','dq','qi','oth','k'])`,
    ),
    index("key_version_key_first_seen_index").on(
      table.keyId,
      table.firstSeen,
      table.id,
    ),
  ],
);

/** Delivery observations; payloads may contain unverified, private remote input. */
export const activityDeliveries = pgTable(
  "activity_deliveries",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    instanceId: uuid("instance_id")
      .$type<Uuid>()
      .notNull()
      .references(() => instances.id, { onDelete: "cascade" }),
    /** The owner of the inbox the request arrived at, or the sending actor. */
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .references(() => actors.id, { onDelete: "set null" }),
    direction: activityDeliveryDirectionEnum().notNull(),
    status: activityDeliveryStatusEnum().notNull(),
    verificationMechanism: activityDeliveryVerificationMechanismEnum(
      "verification_mechanism",
    ),
    verificationResult: activityDeliveryVerificationResultEnum(
      "verification_result",
    ),
    type: text(),
    types: text()
      .array()
      .notNull()
      .default(sql`'{}'`),
    activityIri: text("activity_iri"),
    /**
     * The stored activity `activityIri` names: for an inbound delivery, only
     * one Fedify verified and accepted.  The database enforces the latter;
     * `linkInboundActivity()` matches the IRI.
     */
    activityId: uuid("activity_id")
      .$type<Uuid>()
      .references(() => activities.id, { onDelete: "set null" }),
    objectType: text("object_type"),
    objectIri: text("object_iri"),
    signedKeyIri: text("signed_key_iri"),
    /** A referenced version does not imply successful verification. */
    verificationKeyId: uuid("verification_key_id")
      .$type<Uuid>()
      .references(() => keyVersions.id, { onDelete: "restrict" }),
    /** Inbound, only the first `actor`; the rest are in `payload`. */
    remoteActorIri: text("remote_actor_iri"),
    remoteHost: text("remote_host"),
    inboxUrl: text("inbox_url").notNull(),
    requestUrl: text("request_url"),
    /** Names are lowercase; original order and case are not kept. */
    headers: jsonb().$type<readonly (readonly [string, string])[]>(),
    body: bytea(),
    statusCode: integer("status_code"),
    responseBody: text("response_body"),
    error: text(),
    payload: jsonb().$type<unknown>(),
    recipientIris: text("recipient_iris")
      .array()
      .notNull()
      .default(sql`'{}'`),
    /** Inbound, when the request arrived; outbound, when delivery started. */
    created: instant().notNull().default(currentTimestamp),
    /** Inbound, when DrFed answered; outbound, the latest status change. */
    completed: instant(),
  },
  (table) => [
    check(
      "activity_deliveries_direction_status_check",
      sql`(${table.direction} = 'inbound' AND ${table.status} IN ('received', 'acknowledged', 'unverified', 'rejected')) OR (${table.direction} = 'outbound' AND ${table.status} IN ('queued', 'sent', 'failed', 'permanently_failed', 'abandoned'))`,
    ),
    check(
      "activity_deliveries_completed_check",
      sql`(${table.completed} IS NULL) = (${table.status} = 'queued')`,
    ),
    check(
      "activity_deliveries_status_code_check",
      sql`${table.statusCode} IS NULL OR ${table.statusCode} BETWEEN 100 AND 599`,
    ),
    check(
      "activity_deliveries_outbound_key_check",
      sql`${table.direction} <> 'outbound' OR ${table.verificationKeyId} IS NULL`,
    ),
    check(
      "activity_deliveries_verification_result_check",
      sql`(${table.direction} = 'inbound') = (${table.verificationResult} IS NOT NULL)`,
    ),
    check(
      "activity_deliveries_verification_mechanism_check",
      sql`${table.verificationMechanism} IS NULL OR (${table.direction} = 'inbound' AND ${table.verificationResult} NOT IN ('unattempted', 'unobserved'))`,
    ),
    check(
      "activity_deliveries_body_check",
      sql`(${table.direction} = 'inbound') = (${table.body} IS NOT NULL)`,
    ),
    check(
      "activity_deliveries_activity_check",
      sql`${table.activityId} IS NULL OR ${table.direction} = 'outbound' OR (${table.verificationResult} = 'verified' AND ${table.status} IN ('received', 'acknowledged'))`,
    ),
    index("activity_delivery_instance_created_index").on(
      table.instanceId,
      desc(table.created),
      desc(table.id),
    ),
    index("activity_delivery_actor_index").on(table.actorId),
    index("activity_delivery_activity_created_index").on(
      table.activityId,
      desc(table.created),
      desc(table.id),
    ),
    index("activity_delivery_verification_key_index").on(
      table.verificationKeyId,
    ),
    index("activity_delivery_outbound_index")
      .on(table.activityIri, table.inboxUrl)
      .where(sql`${table.direction} = 'outbound'`),
  ],
);

/** Each ended attempt of an outbound delivery. */
export const activityDeliveryAttempts = pgTable(
  "activity_delivery_attempts",
  {
    id: uuid().$type<Uuid>().primaryKey(),
    deliveryId: uuid("delivery_id")
      .$type<Uuid>()
      .notNull()
      .references(() => activityDeliveries.id, { onDelete: "cascade" }),
    succeeded: boolean().notNull(),
    statusCode: integer("status_code"),
    responseBody: text("response_body"),
    error: text(),
    /** When the attempt ended. */
    created: instant().notNull().default(currentTimestamp),
  },
  (table) => [
    check(
      "activity_delivery_attempts_status_code_check",
      sql`${table.statusCode} IS NULL OR ${table.statusCode} BETWEEN 100 AND 599`,
    ),
    check(
      "activity_delivery_attempts_error_check",
      sql`${table.succeeded} = (${table.error} IS NULL)`,
    ),
    index("activity_delivery_attempt_delivery_index").on(
      table.deliveryId,
      table.created,
      table.id,
    ),
  ],
);

/**
 * The local actors a delivery concerns, one row per delivery and actor; each
 * must be a local actor of the delivery's instance, which the record functions
 * check.
 */
export const activityDeliveryActors = pgTable(
  "activity_delivery_actors",
  {
    deliveryId: uuid("delivery_id")
      .$type<Uuid>()
      .notNull()
      .references(() => activityDeliveries.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id")
      .$type<Uuid>()
      .notNull()
      .references(() => actors.id, { onDelete: "cascade" }),
    inboxOwner: boolean("inbox_owner").notNull().default(false),
    /** Addressed directly or through a collection. */
    addressed: boolean().notNull().default(false),
    /** Addressed by its own IRI; collections are in a row each. */
    addressedDirectly: boolean("addressed_directly").notNull().default(false),
    sender: boolean().notNull().default(false),
    /** The delivery's `created`, which an actor's deliveries are ordered by. */
    created: instant().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.deliveryId, table.actorId] }),
    check(
      "activity_delivery_actors_role_check",
      sql`${table.inboxOwner} OR ${table.addressed} OR ${table.sender}`,
    ),
    check(
      "activity_delivery_actors_addressed_directly_check",
      sql`NOT ${table.addressedDirectly} OR ${table.addressed}`,
    ),
    index("activity_delivery_actor_created_index").on(
      table.actorId,
      desc(table.created),
      desc(table.deliveryId),
    ),
  ],
);

/** Each addressed collection a delivery reached a local actor through. */
export const activityDeliveryActorCollections = pgTable(
  "activity_delivery_actor_collections",
  {
    deliveryId: uuid("delivery_id").$type<Uuid>().notNull(),
    actorId: uuid("actor_id").$type<Uuid>().notNull(),
    collectionIri: text("collection_iri").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.deliveryId, table.actorId, table.collectionIri],
    }),
    foreignKey({
      name: "activity_delivery_actor_collections_link_fkey",
      columns: [table.deliveryId, table.actorId],
      foreignColumns: [
        activityDeliveryActors.deliveryId,
        activityDeliveryActors.actorId,
      ],
    }).onDelete("cascade"),
  ],
);
export type Key = typeof keys.$inferSelect;
export type KeyVersion = typeof keyVersions.$inferSelect;
export type ActivityDelivery = typeof activityDeliveries.$inferSelect;
export type NewActivityDelivery = typeof activityDeliveries.$inferInsert;
export type ActivityDeliveryAttempt =
  typeof activityDeliveryAttempts.$inferSelect;
export type ActivityDeliveryActor = typeof activityDeliveryActors.$inferSelect;
export type NewActivityDeliveryActor =
  typeof activityDeliveryActors.$inferInsert;
export type ActivityDeliveryActorCollection =
  typeof activityDeliveryActorCollections.$inferSelect;
export type ActivityDeliveryDirection =
  (typeof activityDeliveryDirectionEnum.enumValues)[number];
export type ActivityDeliveryStatus =
  (typeof activityDeliveryStatusEnum.enumValues)[number];
export type ActivityDeliveryVerificationMechanism =
  (typeof activityDeliveryVerificationMechanismEnum.enumValues)[number];
export type ActivityDeliveryVerificationResult =
  (typeof activityDeliveryVerificationResultEnum.enumValues)[number];
