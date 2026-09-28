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
} from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import { drizzleConnectionHelpers } from "@pothos/plugin-drizzle";

import builder, { type DrFedObjectRef } from "./builder.ts";

export { createKeyCache } from "./activity-log/keycache.ts";
export {
  classifyInbound,
  createInboundRecorder,
} from "./activity-log/inbound.ts";
export { describeActivity } from "./activity-log/describe.ts";
export {
  deliverActivity,
  createOutboxErrorHandler,
  createPermanentFailureHandler,
} from "./activity-log/outbound.ts";

const ActivityLogDirection = builder.enumType("ActivityLogDirection", {
  values: activityLogDirectionEnum.enumValues,
});
const ActivityLogStatus = builder.enumType("ActivityLogStatus", {
  values: activityLogStatusEnum.enumValues,
});
const ActivityLogFilter = builder.inputType("ActivityLogFilter", {
  fields: (t) => ({
    direction: t.field({ type: ActivityLogDirection }),
    status: t.field({ type: ActivityLogStatus }),
    type: t.string(),
  }),
});
const access = (localId: Uuid | null) =>
  localId == null
    ? false
    : { $any: { admin: true as const, localInstanceMember: localId } };

const KeyRef = builder.drizzleNode("keys", {
  name: "Key",
  authScopes: { authenticated: true },
  runScopesOnType: true,
  id: { column: (key) => key.id },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    iri: t.expose("iri", { type: "URL" }),
    created: t.expose("created", { type: "DateTime" }),
    versions: t.relation("versions", {
      query: { orderBy: { firstSeen: "asc", id: "asc" } },
    }),
  }),
});
export const Key: DrFedObjectRef = KeyRef;
const observationDescription =
  "DrFed observation time, not the remote key rotation time; does not imply continuous use between observations.";
const KeyVersionRef = builder.drizzleNode("keyVersions", {
  name: "KeyVersion",
  authScopes: { authenticated: true },
  runScopesOnType: true,
  id: { column: (version) => version.id },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    key: t.relation("key"),
    publicKey: t.expose("publicKey", { type: "JSON" }),
    fingerprint: t.exposeString("fingerprint"),
    firstSeen: t.expose("firstSeen", {
      type: "DateTime",
      description: observationDescription,
    }),
    lastSeen: t.expose("lastSeen", {
      type: "DateTime",
      description: observationDescription,
    }),
  }),
});
export const KeyVersion: DrFedObjectRef = KeyVersionRef;
const ActivityLogRef = builder.drizzleNode("activityLogs", {
  name: "ActivityLog",
  select: { with: { instance: { columns: { localId: true } } } },
  authScopes: (log) => access(log.instance.localId),
  runScopesOnType: true,
  id: { column: (log) => log.id },
  fields: (t) => ({
    uuid: t.expose("id", { type: "UUID" }),
    instance: t.relation("instance"),
    actor: t.relation("actor", { nullable: true }),
    direction: t.expose("direction", { type: ActivityLogDirection }),
    status: t.expose("status", { type: ActivityLogStatus }),
    type: t.exposeString("type", { nullable: true }),
    activityIri: t.expose("activityIri", { type: "URL", nullable: true }),
    objectType: t.exposeString("objectType", { nullable: true }),
    objectIri: t.expose("objectIri", { type: "URL", nullable: true }),
    signedKeyIri: t.expose("signedKeyIri", { type: "URL", nullable: true }),
    verificationKey: t.relation("verificationKey", {
      nullable: true,
      description:
        "The public key version used in verification, even when it failed. Its presence does not imply success; consult status.",
    }),
    remoteActorIri: t.expose("remoteActorIri", { type: "URL", nullable: true }),
    remoteHost: t.exposeString("remoteHost", { nullable: true }),
    inboxUrl: t.expose("inboxUrl", { type: "URL" }),
    statusCode: t.exposeInt("statusCode", { nullable: true }),
    error: t.exposeString("error", { nullable: true }),
    payload: t.expose("payload", {
      type: "JSON",
      nullable: true,
      description:
        "Original inbound JSON or compact outbound JSON-LD. May contain unverified remote input and private recipients. Null represents a literal JSON null body.",
    }),
    created: t.expose("created", { type: "DateTime" }),
  }),
});
export const ActivityLog: DrFedObjectRef = ActivityLogRef;

const logsConnection = drizzleConnectionHelpers(builder, "activityLogs", {
  query: ({
    filter,
  }: {
    filter?: typeof ActivityLogFilter.$inferInput | null;
  }) => ({
    where: {
      ...(filter?.direction == null ? {} : { direction: filter.direction }),
      ...(filter?.status == null ? {} : { status: filter.status }),
      ...(filter?.type == null ? {} : { type: filter.type }),
    },
    orderBy: { created: "desc", id: "desc" },
  }),
});
builder.drizzleObjectField("instances", "activityLogs", (t) =>
  t.connection({
    type: ActivityLog,
    args: { filter: t.arg({ type: ActivityLogFilter }) },
    description:
      "Delivery observations, newest first. Restricted to local instance members and administrators.",
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
  t.connection({
    type: ActivityLog,
    args: { filter: t.arg({ type: ActivityLogFilter }) },
    description:
      "This local actor's delivery observations, newest first. Restricted to instance members and administrators.",
    select: (args, ctx, nestedSelection) =>
      ({
        columns: { localId: true },
        with: {
          instance: { columns: { localId: true } },
          activityLogs: logsConnection.getQuery(args, ctx, nestedSelection),
        },
      }) as const,
    resolve: (actor, args, ctx) =>
      logsConnection.resolve(actor.activityLogs, args, ctx, actor),
    authScopes: (actor) =>
      actor.localId == null ? false : access(actor.instance.localId),
  }),
);
