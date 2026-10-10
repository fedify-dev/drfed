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
import {
  recordOutbound,
  settleOutbound,
} from "@drfed/models/activity-delivery";
import type { ActivityDelivery } from "@drfed/models/schema";
import type { Uuid } from "@drfed/models/uuid";
import type { Context, Federation } from "@fedify/fedify";
import {
  type Activity,
  PUBLIC_COLLECTION,
  type Recipient,
} from "@fedify/vocab";
import { getLogger } from "@logtape/logtape";

import { canonicalizeAuthority } from "../origin.ts";
import { describeActivity, remoteHost } from "./describe.ts";
import {
  type Delivery,
  type Settlement,
  deliveredStatus,
  failureOf,
  reportsSent,
  withDelivery,
} from "./queue.ts";
import { trackRequest } from "./tracking.ts";

const logger = getLogger(["drfed", "federation", "activity-delivery"]);

const queued = new WeakSet<Federation<unknown>>();

/**
 * The stored activity of an IRI, which a delivery of it is linked to.
 * @returns Its ID, or null when it is not stored or cannot be looked up.
 */
async function findActivityId(
  db: Database,
  activityIri: string,
): Promise<Uuid | null> {
  try {
    const resource = await db.query.resources.findFirst({
      columns: { id: true },
      where: { iri: activityIri, kind: "activity" },
    });
    return resource?.id ?? null;
  } catch (error) {
    logger.error("Could not look up the delivered activity: {error}", {
      error,
    });
    return null;
  }
}

/**
 * How a delivery Fedify returned from without sending or enqueuing settles:
 * no attempt was made, and none will be.
 */
const undelivered: Settlement = {
  status: "permanently_failed",
  attempted: false,
  statusCode: null,
  error: "Fedify made no delivery to the inbox.",
  responseBody: null,
};

/** Mark a federation as delivering through a message queue. */
export function markQueued(federation: Federation<unknown>): void {
  queued.add(federation);
}

/**
 * Group recipients by inbox, without the sender and Public.  Fedify delivers
 * only to a recipient that has both an ID and an inbox, so any other is left
 * out.
 * @returns The recipients of each inbox URL.
 */
export function groupRecipients(
  recipients: readonly Recipient[],
  senderIri: string | undefined,
): Map<string, Recipient[]> {
  const targets = new Map<string, Recipient[]>();
  for (const recipient of recipients) {
    const iri = recipient.id?.href;
    if (
      iri == null ||
      recipient.inboxId == null ||
      iri === senderIri ||
      iri === PUBLIC_COLLECTION.href
    ) {
      continue;
    }
    const url = recipient.inboxId.href;
    const group = targets.get(url) ?? [];
    if (group.some((member) => member.id?.href === iri)) continue;
    targets.set(url, [...group, recipient]);
  }
  return targets;
}

/**
 * Deliver to explicit recipients through the current federation.
 * Each activity needs a unique IRI.  `bto` and `bcc` are removed before delivery.
 * A recipient without an ID or an inbox gets no delivery, and so no record.
 * With a message queue, `createFederation()` settles each attempt the worker
 * makes; without one, the one attempt settles here.
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
  const activityIri = activity.id.href;
  const activityId = await findActivityId(db, activityIri);
  const delivered = activity.clone({ btos: [], bccs: [] });
  const synchronous = !queued.has(ctx.federation);
  const targets = groupRecipients(
    Array.isArray(recipients) ? recipients : [recipients],
    activity.actorId?.href,
  );
  const results = await Promise.allSettled(
    Array.from(targets, async ([inboxUrl, group]) => {
      let row: ActivityDelivery | undefined;
      try {
        const payload = await delivered.toJsonLd({
          format: "compact",
          contextLoader: ctx.contextLoader,
        });
        const description = await describeActivity(payload, {
          contextLoader: ctx.contextLoader,
        });
        const recipientIris = group.flatMap((recipient) =>
          recipient.id == null ? [] : [recipient.id.href],
        );
        const remoteActorIri =
          group.length === 1 ? (recipientIris[0] ?? null) : null;
        row = await recordOutbound(db, {
          ...description,
          instanceId: actor.instanceId,
          actorId: actor.id,
          activityIri,
          activityId,
          remoteActorIri,
          remoteHost: remoteHost(remoteActorIri, inboxUrl),
          inboxUrl,
          recipientIris,
          payload,
        });
      } catch (error) {
        logger.error("Could not record outgoing activity: {error}", { error });
      }
      const settle = async (settlement: Settlement) => {
        if (row == null) return;
        try {
          await settleOutbound(db, {
            ...settlement,
            id: row.id,
            activityIri,
            inboxUrl,
          });
        } catch (error) {
          logger.error("Could not settle outgoing activity: {error}", {
            error,
          });
        }
      };
      // Resolve each destination independently: one failing inbox must not mark
      // a successful delivery as failed or leave it queued.
      const send = () => ctx.sendActivity(sender, group, delivered);
      const delivery: Delivery | undefined =
        row == null
          ? undefined
          : { deliveryId: row.id, inboxUrl, enqueued: false };
      const { spans, responses } = await trackRequest(() =>
        delivery == null ? send() : withDelivery(delivery, send),
      ).catch(async (error: unknown) => {
        await settle({
          ...failureOf(error),
          status: "failed",
          attempted: true,
        });
        throw error;
      });
      // Fedify returns without sending to a recipient it leaves out: the sent
      // event tells a delivery made from none, and the enqueued message a
      // delivery pending from none.  A group is always one inbox, so Fedify
      // never fans it out through a queue.
      if (synchronous) {
        await settle(
          reportsSent(spans, inboxUrl)
            ? {
                status: "sent",
                attempted: true,
                statusCode: deliveredStatus(responses, inboxUrl),
              }
            : undelivered,
        );
      } else if (delivery?.enqueued === false) {
        await settle(undelivered);
      }
    }),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
