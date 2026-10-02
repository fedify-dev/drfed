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

import {
  activityLogDirectionEnum,
  activityLogStatusEnum,
  activityLogVerificationMechanismEnum,
  activityLogVerificationResultEnum,
} from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";

import builder, { type DrFedObjectRef } from "../builder.ts";

export { createKeyCache } from "./keycache.ts";
export {
  classifyInbound,
  createInboundRecorder,
  parseBody,
  recordedHeaders,
} from "./inbound.ts";
export { describeActivity } from "./describe.ts";
export {
  declaredKeyId,
  hasLdSignature,
  proofMethods,
  reportedVerdict,
} from "./verification.ts";
export { deliverActivity, groupRecipients } from "./outbound.ts";
export { failureOf, queuedSettlements } from "./queue.ts";
export type { ObservedKeyFetch, ObservedSpan } from "./tracking.ts";

const ActivityLogDirection = builder.enumType("ActivityLogDirection", {
  description: "Whether DrFed received the delivery or made it.",
  values: activityLogDirectionEnum.enumValues,
});
const ActivityLogStatus = builder.enumType("ActivityLogStatus", {
  description:
    "What became of a delivery.  Inbound values follow the response DrFed " +
    "gave, a request whose handling threw counting as refused; outbound " +
    "values follow the delivery attempt.",
  values: {
    received: {
      description: "Inbound: answered 2xx and the inbox listener ran.",
    },
    acknowledged: {
      description:
        "Inbound: answered 2xx without running the inbox listener, e.g. a " +
        "duplicate of an already processed activity or an unsupported type.",
    },
    unverified: {
      description: "Inbound: refused, and no signature or proof was verified.",
    },
    rejected: {
      description:
        "Inbound: refused although a signature or proof was verified.",
    },
    queued: {
      description: "Outbound: started, and no attempt has ended yet.",
    },
    sent: { description: "Outbound: the remote inbox accepted the delivery." },
    failed: {
      description:
        "Outbound: the latest attempt failed.  With a message queue, it may " +
        "still be retried.",
    },
    permanently_failed: {
      description:
        "Outbound: given up without further retries, because the remote " +
        "inbox answered with a permanent failure status, or because the " +
        "circuit breaker for its host held the delivery too long.",
    },
    abandoned: {
      description:
        "Outbound: the retry policy ran out after the latest attempt failed.",
    },
  } satisfies Record<(typeof activityLogStatusEnum.enumValues)[number], object>,
});
const VerificationMechanism = builder.enumType(
  "ActivityLogVerificationMechanism",
  {
    description:
      "How an inbound activity was authenticated.  Not to be confused with " +
      "FEP-8b32's `verificationMethod`, which is a key.",
    values: {
      http_signature: { description: "The HTTP request signature." },
      ld_signature: { description: "Linked Data Signatures (`signature`)." },
      object_integrity_proof: {
        description: "FEP-8b32 Object Integrity Proofs (`proof`).",
      },
    } satisfies Record<
      (typeof activityLogVerificationMechanismEnum.enumValues)[number],
      object
    >,
  },
);
const VerificationResult = builder.enumType("ActivityLogVerificationResult", {
  description:
    "What Fedify reported of verifying an inbound activity, as it " +
    "verified it.  Whether the activity was accepted is " +
    "`ActivityLog.status`.",
  values: {
    verified: { description: "A signature or proof was verified." },
    invalid_signature: {
      description: "A signature or proof was present and did not verify.",
    },
    key_fetch_error: {
      description:
        "The key a signature or proof names could not be fetched, or what " +
        "was fetched held no usable key.",
    },
    no_signature: { description: "Nothing to verify was found." },
    unattempted: {
      description:
        "Fedify answered before verifying anything, e.g. a body that is " +
        "not JSON or an unknown inbox.",
    },
    unobserved: {
      description:
        "Recording the observation failed; the mechanism is unknown.",
    },
  } satisfies Record<
    (typeof activityLogVerificationResultEnum.enumValues)[number],
    object
  >,
});
const ActivityLogFilter = builder.inputType("ActivityLogFilter", {
  fields: (t) => ({
    direction: t.field({ type: ActivityLogDirection }),
    status: t.field({ type: ActivityLogStatus }),
    type: t.string(),
  }),
});
function decodeUtf8(body: Uint8Array | null): string | null {
  if (body == null) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}
const access = (localId: Uuid | null) =>
  localId == null
    ? false
    : { $any: { admin: true as const, localInstanceMember: localId } };

builder.drizzleObject("activityLogAttempts", {
  name: "ActivityLogAttempt",
  description: "One ended attempt of an outbound delivery.",
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    succeeded: t.exposeBoolean("succeeded"),
    statusCode: t.exposeInt("statusCode", {
      nullable: true,
      description:
        "The status the remote inbox answered the attempt with.  Null " +
        "when no response came, as for a network error.",
    }),
    responseBody: t.exposeString("responseBody", {
      nullable: true,
      description:
        "What the remote inbox answered a failed attempt, with U+FFFD for " +
        "each U+0000, which PostgreSQL cannot store.",
    }),
    error: t.exposeString("error", {
      nullable: true,
      description:
        "Why the attempt failed, including the causes of a network error.  " +
        "Null for a success.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description: "When the attempt ended.",
    }),
  }),
});

const ActivityLogRef = builder.drizzleNode("activityLogs", {
  name: "ActivityLog",
  select: { with: { instance: { columns: { localId: true } } } },
  authScopes: (log) => access(log.instance.localId),
  runScopesOnType: true,
  id: { column: (log) => log.id },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    instance: t.relation("instance"),
    actor: t.relation("actor", {
      nullable: true,
      description:
        "The owner of the inbox the request arrived at, or the sending " +
        "actor.  Null for the shared inbox, and for a deleted actor.",
    }),
    direction: t.expose("direction", { type: ActivityLogDirection }),
    status: t.expose("status", {
      type: ActivityLogStatus,
      description:
        "The outcome of the delivery.  Inbound, it follows the response " +
        "DrFed gave, not `verificationResult`.",
    }),
    verificationMechanism: t.expose("verificationMechanism", {
      type: VerificationMechanism,
      nullable: true,
      description:
        "Inbound: the mechanism that verified the activity, or the last " +
        "one Fedify tried.  Null when Fedify tried none, when recording " +
        "failed, and for outbound logs.",
    }),
    verificationResult: t.expose("verificationResult", {
      type: VerificationResult,
      nullable: true,
      description: "Inbound: what verifying found.  Null for outbound logs.",
    }),
    type: t.exposeString("type", {
      nullable: true,
      description: "The one type the activity resolved to; see `types`.",
    }),
    types: t.exposeStringList("types", {
      description: "Every type the activity declares.",
    }),
    activityIri: t.expose("activityIri", { type: "URL", nullable: true }),
    objectType: t.exposeString("objectType", { nullable: true }),
    objectIri: t.expose("objectIri", { type: "URL", nullable: true }),
    signedKeyIri: t.expose("signedKeyIri", {
      type: "URL",
      nullable: true,
      description:
        "The `keyId` the HTTP signature declares.  It may differ from the " +
        "IRI of `verificationKey` when another mechanism verified the " +
        "activity.",
    }),
    verificationKey: t.relation("verificationKey", {
      nullable: true,
      description:
        "The public key version `verificationMechanism` actually used, even " +
        "when it failed.  Its presence does not imply success; consult " +
        "`verificationResult`.",
    }),
    remoteActorIri: t.expose("remoteActorIri", { type: "URL", nullable: true }),
    remoteHost: t.exposeString("remoteHost", { nullable: true }),
    inboxUrl: t.expose("inboxUrl", {
      type: "URL",
      description:
        "The canonical IRI of the inbox, however the request spelled it; " +
        "see `requestUrl`.",
    }),
    requestUrl: t.expose("requestUrl", {
      type: "URL",
      nullable: true,
      description: "Inbound: the URL the request actually arrived at.",
    }),
    requestHeaders: t.expose("headers", {
      type: "JSON",
      nullable: true,
      description:
        "Inbound: the request headers as `[name, value]` pairs with " +
        "lowercase names; their original order and case are not kept.  " +
        "`cookie` is left out, and `authorization` is whole only for the " +
        "`Signature` scheme.",
    }),
    rawBody: t.string({
      nullable: true,
      description:
        "Inbound: the request body as received, when it is valid UTF-8; " +
        "otherwise read `rawBodyBase64`.",
      select: { columns: { body: true } },
      resolve: (log) => decodeUtf8(log.body),
    }),
    rawBodyBase64: t.string({
      nullable: true,
      description: "Inbound: the octets of the request body, in Base64.",
      select: { columns: { body: true } },
      resolve: (log) => log.body?.toString("base64") ?? null,
    }),
    statusCode: t.exposeInt("statusCode", {
      nullable: true,
      description:
        "Inbound: what DrFed answered; null when handling the request " +
        "threw.  Outbound: what the remote inbox answered the latest " +
        "attempt; null when no response came.",
    }),
    responseBody: t.exposeString("responseBody", {
      nullable: true,
      description:
        "Inbound: what DrFed answered; null when handling the request " +
        "threw.  Outbound: what the remote inbox answered the latest failed " +
        "attempt, with U+FFFD for each U+0000, which PostgreSQL cannot store.",
    }),
    error: t.exposeString("error", {
      nullable: true,
      description:
        "Why a refused or failed delivery ended that way, which for an " +
        "inbound request whose handling threw is the exception.  Null for " +
        "accepted ones.",
    }),
    attempts: t.relatedConnection("attempts", {
      query: { orderBy: { created: "asc", id: "asc" } },
      description:
        "Outbound: each attempt that ended, oldest first, including the " +
        "retries of a queued delivery.  Empty for inbound logs.",
    }),
    payload: t.expose("payload", {
      type: "JSON",
      nullable: true,
      description:
        "Inbound: `rawBody` parsed as JSON, which loses key order, " +
        "whitespace and duplicate keys; null when it does not parse, when " +
        "it holds U+0000 or an unpaired surrogate, which PostgreSQL cannot " +
        "store, and for a literal JSON null.  Outbound: the compact JSON-LD " +
        "before signing, without `bto` and `bcc`, so it lacks the `proof` " +
        "and `signature` the remote server received.  May contain " +
        "unverified remote input and private recipients.",
    }),
    recipientIris: t.expose("recipientIris", {
      type: ["URL"],
      description:
        "Outbound: every recipient sharing the inbox, including those " +
        "named by `bto` and `bcc`.",
    }),
    created: t.expose("created", {
      type: "DateTime",
      description:
        "Inbound: when the request arrived, before it was verified and " +
        "handled.  Outbound: when DrFed started the delivery.  Logs are " +
        "ordered by it.",
    }),
    completed: t.expose("completed", {
      type: "DateTime",
      nullable: true,
      description:
        "Inbound: when DrFed answered the request.  Outbound: when " +
        "`status` last changed.  Null while an outbound delivery is " +
        "`queued`.",
    }),
  }),
});
export const ActivityLog: DrFedObjectRef = ActivityLogRef;

type LogFilter = typeof ActivityLogFilter.$inferInput | null | undefined;
const logWhere = (filter: LogFilter) => ({
  ...(filter?.direction == null ? {} : { direction: filter.direction }),
  ...(filter?.status == null ? {} : { status: filter.status }),
  ...(filter?.type == null ? {} : { type: filter.type }),
});
const logsConnection = drizzleConnectionHelpers(builder, "activityLogs", {
  query: ({ filter }: { filter?: LogFilter }) => ({
    where: logWhere(filter),
    orderBy: { created: "desc", id: "desc" },
  }),
});
// Paged over an actor's links, which copy the created of their logs, so that
// each edge tells how the log concerns the actor.
const actorLogsConnection = drizzleConnectionHelpers(
  builder,
  "activityLogActors",
  {
    query: ({ filter }: { filter?: LogFilter }) => ({
      where: { log: logWhere(filter) },
      orderBy: { created: "desc", logId: "desc" },
    }),
    select: (nestedSelection) => ({
      with: {
        log: nestedSelection(),
        // Every column, since Pothos cannot add a composite primary key to
        // a narrower selection.
        collections: { orderBy: { collectionIri: "asc" } },
      },
    }),
    resolveNode: (link) => link.log,
  },
);
builder.drizzleObjectField("instances", "activityLogs", (t) =>
  t.connection({
    type: ActivityLog,
    args: { filter: t.arg({ type: ActivityLogFilter }) },
    description:
      "Delivery observations, newest first. " +
      "Restricted to local instance members and administrators.",
    select: (args, ctx, nestedSelection) =>
      ({
        columns: { localId: true },
        with: {
          activityLogs: logsConnection.getQuery(args, ctx, nestedSelection),
        },
      }) as const,
    resolve: (instance, args, ctx) =>
      logsConnection.resolve(instance.activityLogs, args, ctx, instance),
    authScopes: (instance) => access(instance.localId),
  }),
);
builder.drizzleObjectField("actors", "activityLogs", (t) =>
  t.connection(
    {
      type: ActivityLog,
      args: { filter: t.arg({ type: ActivityLogFilter }) },
      description:
        "Deliveries that concern this local actor, newest first: those " +
        "that arrived at its inbox, those it sent, and those addressed to " +
        "it through any inbox, directly or as a member of an addressed " +
        "collection.  Collection membership counts only as far as DrFed " +
        "has stored it.  Each edge tells how the delivery concerns the " +
        "actor.  Restricted to instance members and administrators.",
      select: (args, ctx, nestedSelection) =>
        ({
          columns: { localId: true },
          with: {
            instance: { columns: { localId: true } },
            activityLogLinks: actorLogsConnection.getQuery(
              args,
              ctx,
              nestedSelection,
            ),
          },
        }) as const,
      resolve: (actor, args, ctx) =>
        actorLogsConnection.resolve(actor.activityLogLinks, args, ctx, actor),
      authScopes: (actor) =>
        actor.localId == null ? false : access(actor.instance.localId),
    },
    {},
    {
      fields: (edge) => ({
        inboxOwner: edge.exposeBoolean("inboxOwner", {
          description: "Whether the delivery arrived at this actor's inbox.",
        }),
        sender: edge.exposeBoolean("sender", {
          description: "Whether this actor sent the delivery.",
        }),
        addressed: edge.exposeBoolean("addressed", {
          description:
            "Whether the activity addressed this actor, directly or " +
            "through a collection.",
        }),
        addressedDirectly: edge.exposeBoolean("addressedDirectly", {
          description: "Whether the activity addressed this actor by its IRI.",
        }),
        viaCollections: edge.field({
          type: ["URL"],
          description:
            "The addressed collections this actor was a member of when the " +
            "delivery arrived, as far as DrFed had stored them, in IRI " +
            "order.  Empty when no collection addressed it.",
          resolve: (link) =>
            link.collections.map(({ collectionIri }) => collectionIri),
        }),
      }),
    },
  ),
);
