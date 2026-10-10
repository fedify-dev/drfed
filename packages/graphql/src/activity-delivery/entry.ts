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
  activityDeliveryDirectionEnum,
  activityDeliveryStatusEnum,
  activityDeliveryVerificationMechanismEnum,
  activityDeliveryVerificationResultEnum,
} from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";

import builder, { type DrFedObjectRef } from "../builder.ts";
import { viewableInstance } from "../readable.ts";

const ActivityDeliveryDirection = builder.enumType(
  "ActivityDeliveryDirection",
  {
    description: "Whether DrFed received the delivery or made it.",
    values: activityDeliveryDirectionEnum.enumValues,
  },
);
const ActivityDeliveryStatus = builder.enumType("ActivityDeliveryStatus", {
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
  } satisfies Record<
    (typeof activityDeliveryStatusEnum.enumValues)[number],
    object
  >,
});
const VerificationMechanism = builder.enumType(
  "ActivityDeliveryVerificationMechanism",
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
      (typeof activityDeliveryVerificationMechanismEnum.enumValues)[number],
      object
    >,
  },
);
const VerificationResult = builder.enumType(
  "ActivityDeliveryVerificationResult",
  {
    description:
      "What Fedify reported of verifying an inbound activity, as it " +
      "verified it.  Whether the activity was accepted is " +
      "`ActivityDelivery.status`.",
    values: {
      verified: { description: "A signature or proof was verified." },
      invalid_signature: {
        description: "A signature or proof was present and did not verify.",
      },
      key_fetch_error: {
        description:
          "Fedify reported a failure fetching the key a signature or proof names.",
      },
      no_signature: { description: "Nothing to verify was found." },
      unattempted: {
        description:
          "Fedify stopped before checking a signature or proof, e.g. a body that is " +
          "not JSON or an unknown inbox.",
      },
      unobserved: {
        description:
          "Recording the observation failed; the mechanism is unknown.",
      },
    } satisfies Record<
      (typeof activityDeliveryVerificationResultEnum.enumValues)[number],
      object
    >,
  },
);
const ActivityDeliveryFilter = builder.inputType("ActivityDeliveryFilter", {
  fields: (t) => ({
    direction: t.field({ type: ActivityDeliveryDirection }),
    status: t.field({ type: ActivityDeliveryStatus }),
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

builder.drizzleObject("activityDeliveryAttempts", {
  name: "ActivityDeliveryAttempt",
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

const ActivityDeliveryRef = builder.drizzleNode("activityDeliveries", {
  name: "ActivityDelivery",
  select: { with: { instance: { columns: { localId: true } } } },
  authScopes: (delivery) => access(delivery.instance.localId),
  runScopesOnType: true,
  id: { column: (delivery) => delivery.id },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    instance: t.relation("instance"),
    actor: t.relation("actor", {
      nullable: true,
      description:
        "The owner of the inbox the request arrived at, or the sending " +
        "actor.  Null for the shared inbox, and for a deleted actor.",
    }),
    direction: t.expose("direction", { type: ActivityDeliveryDirection }),
    status: t.expose("status", {
      type: ActivityDeliveryStatus,
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
        "failed, and for outbound deliveries.",
    }),
    verificationResult: t.expose("verificationResult", {
      type: VerificationResult,
      nullable: true,
      description:
        "Inbound: what verifying found.  Null for outbound deliveries.",
    }),
    type: t.exposeString("type", {
      nullable: true,
      description: "The one type the activity resolved to; see `types`.",
    }),
    types: t.exposeStringList("types", {
      description: "Every type the activity declares.",
    }),
    activityIri: t.expose("activityIri", { type: "URL", nullable: true }),
    activity: t.relation("activity", {
      nullable: true,
      description:
        "The stored activity `activityIri` names, for an inbound delivery " +
        "that was verified and accepted, or a delivery DrFed sent.  Null " +
        "when the activity has no ID, did not meet the rules for storing " +
        "it, or the delivery was not verified.",
    }),
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
      resolve: (delivery) => decodeUtf8(delivery.body),
    }),
    rawBodyBase64: t.string({
      nullable: true,
      description: "Inbound: the octets of the request body, in Base64.",
      select: { columns: { body: true } },
      resolve: (delivery) => delivery.body?.toString("base64") ?? null,
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
        "accepted ones unless verification observation failed.",
    }),
    attempts: t.relatedConnection("attempts", {
      query: { orderBy: { created: "asc", id: "asc" } },
      description:
        "Outbound: each attempt that ended, oldest first, including the " +
        "retries of a queued delivery.  Empty for inbound deliveries.",
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
        "handled.  Outbound: when DrFed started the delivery.  Deliveries " +
        "are ordered by it.",
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
export const ActivityDelivery: DrFedObjectRef = ActivityDeliveryRef;

type DeliveryFilter =
  | typeof ActivityDeliveryFilter.$inferInput
  | null
  | undefined;
const deliveryWhere = (filter: DeliveryFilter) => ({
  ...(filter?.direction == null ? {} : { direction: filter.direction }),
  ...(filter?.status == null ? {} : { status: filter.status }),
  ...(filter?.type == null ? {} : { type: filter.type }),
});
const deliveriesConnection = drizzleConnectionHelpers(
  builder,
  "activityDeliveries",
  {
    query: ({ filter }: { filter?: DeliveryFilter }) => ({
      where: deliveryWhere(filter),
      orderBy: { created: "desc", id: "desc" },
    }),
  },
);
// Paged over an actor's links, which copy the created of their deliveries, so
// that each edge tells how the delivery concerns the actor.
const actorDeliveriesConnection = drizzleConnectionHelpers(
  builder,
  "activityDeliveryActors",
  {
    query: ({ filter }: { filter?: DeliveryFilter }) => ({
      where: { delivery: deliveryWhere(filter) },
      orderBy: { created: "desc", deliveryId: "desc" },
    }),
    select: (nestedSelection) => ({
      with: {
        delivery: nestedSelection(),
        // Every column, since Pothos cannot add a composite primary key to
        // a narrower selection.
        collections: { orderBy: { collectionIri: "asc" } },
      },
    }),
    resolveNode: (link) => link.delivery,
  },
);
builder.drizzleObjectField("instances", "activityDeliveries", (t) =>
  t.connection({
    type: ActivityDelivery,
    args: { filter: t.arg({ type: ActivityDeliveryFilter }) },
    description:
      "Delivery observations, newest first. " +
      "Restricted to local instance members and administrators.",
    select: (args, ctx, nestedSelection) =>
      ({
        columns: { localId: true },
        with: {
          activityDeliveries: deliveriesConnection.getQuery(
            args,
            ctx,
            nestedSelection,
          ),
        },
      }) as const,
    resolve: (instance, args, ctx) =>
      deliveriesConnection.resolve(
        instance.activityDeliveries,
        args,
        ctx,
        instance,
      ),
    authScopes: (instance) => access(instance.localId),
  }),
);
// Rows are filtered before paging: an activity's deliveries span instances,
// and the node's own check would fail the whole connection, while cursors
// and page info would tell of rows it hides.
const activityDeliveriesConnection = drizzleConnectionHelpers(
  builder,
  "activityDeliveries",
  {
    query: ({ filter }: { filter?: DeliveryFilter }, ctx) => ({
      where: {
        ...deliveryWhere(filter),
        RAW: (table) => viewableInstance(ctx, table.instanceId),
      },
      orderBy: { created: "desc", id: "desc" },
    }),
  },
);
builder.drizzleObjectField("activities", "deliveries", (t) =>
  t.connection({
    type: ActivityDelivery,
    args: { filter: t.arg({ type: ActivityDeliveryFilter }) },
    description:
      "Deliveries of this activity, newest first: those it arrived in, " +
      "verified and accepted, and those DrFed sent it in.  Only those of " +
      "the local instances the viewer is a member of, or of every one for " +
      "an administrator.",
    select: (args, ctx, nestedSelection) => ({
      with: {
        deliveries: activityDeliveriesConnection.getQuery(
          args,
          ctx,
          nestedSelection,
        ),
      },
    }),
    resolve: (activity, args, ctx) =>
      activityDeliveriesConnection.resolve(
        activity.deliveries,
        args,
        ctx,
        activity,
      ),
  }),
);
builder.drizzleObjectField("actors", "activityDeliveries", (t) =>
  t.connection(
    {
      type: ActivityDelivery,
      args: { filter: t.arg({ type: ActivityDeliveryFilter }) },
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
            activityDeliveryLinks: actorDeliveriesConnection.getQuery(
              args,
              ctx,
              nestedSelection,
            ),
          },
        }) as const,
      resolve: (actor, args, ctx) =>
        actorDeliveriesConnection.resolve(
          actor.activityDeliveryLinks,
          args,
          ctx,
          actor,
        ),
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
