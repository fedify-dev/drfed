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

import type { Database } from "@drfed/models";
import { recordOutbound, settleOutbound } from "@drfed/models/activity-log";
import type { ActivityLog } from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import {
  type Context,
  type OutboxErrorHandler,
  type OutboxPermanentFailureHandler,
  SendActivityError,
} from "@fedify/fedify";
import type { Activity, Recipient } from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";

import { canonicalizeAuthority } from "../origin.ts";
import { describeActivity, remoteHost } from "./describe.ts";

const logger = getLogger(["drfed", "graphql", "activity-log"]);

/**
 * Record HTTP failures without making diagnostic persistence affect delivery.
 * @returns A Fedify outbox error callback.
 */
export function createOutboxErrorHandler(db: Database): OutboxErrorHandler {
  return async (error, activity) => {
    if (!(error instanceof SendActivityError) || activity?.id == null) return;
    try {
      await settleOutbound(db, {
        activityIri: activity.id.href,
        inboxUrl: error.inbox.href,
        status: "failed",
        statusCode: error.statusCode,
        error: error.responseBody,
      });
    } catch (cause) {
      logger.error("Could not record delivery failure: {error}", {
        error: cause,
      });
    }
  };
}

/**
 * Preserve permanent failures even if the general error callback follows them.
 * @returns A Fedify permanent-failure callback.
 */
export function createPermanentFailureHandler(
  db: Database,
): OutboxPermanentFailureHandler<unknown> {
  return async (_ctx, values) => {
    if (values.activity.id == null) return;
    try {
      await settleOutbound(db, {
        activityIri: values.activity.id.href,
        inboxUrl: values.inbox.href,
        status: "permanently_failed",
        statusCode: values.statusCode,
        error: values.error.responseBody,
      });
    } catch (error) {
      logger.error("Could not record permanent delivery failure: {error}", {
        error,
      });
    }
  };
}

/**
 * Deliver to explicit recipients through the current synchronous federation.
 * Each activity needs a unique IRI. Queue-backed delivery is not supported.
 * Local actor key dispatchers must be registered before using this entry point.
 */
export async function deliverActivity(
  db: Database,
  ctx: Context<unknown>,
  sender: { identifier: Uuid },
  recipients: Recipient | Recipient[],
  activity: Activity,
): Promise<void> {
  if (activity.id == null) {
    throw new TypeError("A delivered activity must have an ID.");
  }
  const actor = await db.query.actors.findFirst({
    where: {
      id: sender.identifier,
      localId: { isNotNull: true },
      instance: {
        host: canonicalizeAuthority(ctx.host),
        localId: { isNotNull: true },
      },
    },
  });
  if (actor == null) {
    throw new TypeError("Delivery requires a local sender on this instance.");
  }
  const targets = new Map<string, Recipient[]>();
  for (const recipient of Array.isArray(recipients)
    ? recipients
    : [recipients]) {
    if (recipient.inboxId == null) continue;
    const url = recipient.inboxId.href;
    targets.set(url, [...(targets.get(url) ?? []), recipient]);
  }
  const results = await Promise.allSettled(
    Array.from(targets, async ([inboxUrl, group]) => {
      let row: ActivityLog | undefined;
      try {
        const payload = await activity.toJsonLd({
          format: "compact",
          contextLoader: ctx.contextLoader,
        });
        const description = await describeActivity(payload, {
          contextLoader: ctx.contextLoader,
        });
        const recipient = group[0]!;
        row = await recordOutbound(db, {
          ...description,
          instanceId: actor.instanceId,
          actorId: actor.id,
          activityIri: activity.id!.href,
          remoteActorIri: recipient.id?.href ?? null,
          remoteHost: remoteHost(recipient.id?.href ?? null, inboxUrl),
          inboxUrl,
          payload,
        });
      } catch (error) {
        logger.error("Could not record outgoing activity: {error}", { error });
      }
      const settle = async (status: "sent" | "failed", error?: unknown) => {
        if (row == null) return;
        try {
          await settleOutbound(db, {
            id: row.id,
            activityIri: activity.id!.href,
            inboxUrl,
            status,
            onlyQueued: true,
            error: error == null ? null : String(error),
          });
        } catch (cause) {
          logger.error("Could not settle outgoing activity: {error}", {
            error: cause,
          });
        }
      };
      try {
        // Resolve each destination independently: one failing inbox must not mark
        // a successful delivery as failed or leave it queued.
        await ctx.sendActivity(sender, group, activity);
      } catch (error) {
        await settle("failed", error);
        throw error;
      }
      await settle("sent");
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
