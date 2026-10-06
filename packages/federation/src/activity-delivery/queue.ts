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

import { AsyncLocalStorage } from "node:async_hooks";

import type { Database } from "@drfed/models";
import {
  type OutboundSettlement,
  receiveInbound,
  settleOutbound,
} from "@drfed/models/activity-delivery";
import { type Uuid, validateUuid } from "@drfed/models/uuid";
import {
  type FederationQueueOptions,
  type KvKey,
  type KvStore,
  type MessageQueue,
  type OutboxErrorHandler,
  type OutboxPermanentFailureHandler,
  SendActivityError,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";

import {
  type ObservedResponse,
  type ObservedSpan,
  trackRequest,
  tracking,
  untracked,
} from "./tracking.ts";

const logger = getLogger(["drfed", "federation", "activity-delivery"]);

/** How a delivery settles, apart from which delivery it is. */
export type Settlement = Omit<
  OutboundSettlement,
  "activityIri" | "inboxUrl" | "id"
>;

/** What a failed attempt shows. */
export interface Failure {
  readonly statusCode: number | null;
  readonly error: string;
  readonly responseBody: string | null;
}

const MAX_CAUSES = 3;

/**
 * Network failures such as `fetch failed` carry DNS, TCP or TLS errors as
 * causes.
 * @returns The error with the causes it names.
 */
export function describeError(error: unknown, depth = 0): string {
  return error instanceof Error && error.cause != null && depth < MAX_CAUSES
    ? `${String(error)} (cause: ${describeError(error.cause, depth + 1)})`
    : String(error);
}

/**
 * Keep the remote response of an HTTP failure, and the causes of any other.
 * @returns What the failed attempt shows.
 */
export function failureOf(error: unknown): Failure {
  return error instanceof SendActivityError
    ? {
        statusCode:
          error.statusCode >= 100 && error.statusCode <= 599
            ? error.statusCode
            : null,
        error: error.message,
        responseBody: error.responseBody,
      }
    : { statusCode: null, error: describeError(error), responseBody: null };
}

/** What Fedify's outbox worker reported while handling one message. */
export interface QueuedAttempt {
  readonly activityIri: string;
  readonly inboxUrl: string;
  /** The delivery the message belongs to, if it names one. */
  readonly deliveryId?: Uuid;
  failure?: Failure;
  permanent?: Failure;
  /** Fedify reported `activitypub.activity.sent` for the inbox. */
  sent?: boolean;
  /** What the remote inbox answered the attempt. */
  statusCode?: number | null;
  /** The `activitypub.outbox.activity` results Fedify measured. */
  outcomes?: readonly string[];
}

/**
 * The delivery a queued message belongs to, carried with it through retries.
 */
const DELIVERY_ID = "drfedActivityDeliveryId";

interface OutboxMessage {
  readonly type: "outbox";
  readonly activityId?: string;
  readonly inbox: string;
  readonly [DELIVERY_ID]?: unknown;
}

interface InboxMessage {
  readonly type: "inbox";
  readonly activity?: unknown;
  readonly [DELIVERY_ID]?: unknown;
}

const attempts = new AsyncLocalStorage<QueuedAttempt>();
const receptions = new AsyncLocalStorage<{
  readonly activityIri: string | undefined;
  readonly deliveryId: Uuid;
}>();
/** A delivery being run, which notes the outbox message enqueued for it. */
export interface Delivery {
  readonly deliveryId: Uuid;
  readonly inboxUrl: string;
  /** Whether an outbox message to the inbox has been enqueued. */
  enqueued: boolean;
}

const deliveries = new AsyncLocalStorage<Delivery>();

const typed = (message: unknown, type: string): boolean =>
  typeof message === "object" &&
  message != null &&
  (message as { type?: unknown }).type === type;
const isOutbox = (message: unknown): message is OutboxMessage =>
  typed(message, "outbox");
const isInbox = (message: unknown): message is InboxMessage =>
  typed(message, "inbox");
const inboxActivityIri = (message: InboxMessage): string | undefined => {
  const { activity } = message;
  const id =
    typeof activity === "object" && activity != null
      ? (activity as { id?: unknown }).id
      : undefined;
  return typeof id === "string" ? id : undefined;
};
const loggedIn = (message: { readonly [DELIVERY_ID]?: unknown }) => {
  const deliveryId = message[DELIVERY_ID];
  return typeof deliveryId === "string" && validateUuid(deliveryId)
    ? deliveryId
    : undefined;
};

/**
 * Run a delivery so that the outbox messages it enqueues name its record, which
 * lets each attempt settle that record even if the activity is sent twice, and
 * so that the delivery knows whether one was enqueued at all.
 * @returns The result of the run.
 */
export function withDelivery<T>(
  delivery: Delivery,
  run: () => Promise<T>,
): Promise<T> {
  return deliveries.run(delivery, run);
}

/**
 * The delivery a message being enqueued belongs to: the delivery or the inbox
 * request enqueuing it, or, for a retry, the message being handled.
 * @returns The delivery ID, if any.
 */
function deliveryOf(message: unknown): Uuid | undefined {
  if (isOutbox(message)) {
    const delivery = deliveries.getStore();
    if (delivery != null && message.inbox === delivery.inboxUrl) {
      delivery.enqueued = true;
      return delivery.deliveryId;
    }
    const attempt = attempts.getStore();
    return attempt != null &&
      message.activityId === attempt.activityIri &&
      message.inbox === attempt.inboxUrl
      ? attempt.deliveryId
      : undefined;
  }
  if (isInbox(message)) {
    const reception = receptions.getStore();
    if (reception != null) {
      return inboxActivityIri(message) === reception.activityIri
        ? reception.deliveryId
        : undefined;
    }
    return tracking()?.inboundDeliveryId;
  }
  return undefined;
}

function tag(message: unknown): unknown {
  const deliveryId = deliveryOf(message);
  return deliveryId == null
    ? message
    : { ...(message as object), [DELIVERY_ID]: deliveryId };
}

const RECEIVED_TTL = Temporal.Duration.from({ hours: 1 });
const receivedKey = (deliveryId: Uuid): KvKey => [
  "drfed",
  "activityDelivery",
  "received",
  deliveryId,
];

async function receive(
  db: Database,
  kv: KvStore,
  deliveryId: Uuid,
): Promise<void> {
  try {
    // Mark first: the inbox request may not have recorded its delivery yet, and
    // it looks for the mark once it has.
    await kv.set(receivedKey(deliveryId), true, { ttl: RECEIVED_TTL });
    await receiveInbound(db, deliveryId);
  } catch (error) {
    logger.error("Could not record a queued inbox reception: {error}", {
      error,
    });
  }
}

/**
 * Settle an inbound delivery recorded after the queue worker already ran its
 * inbox listener, which left a mark for it.
 */
export async function receivedMeanwhile(
  db: Database,
  kv: KvStore,
  deliveryId: Uuid,
): Promise<void> {
  if ((await kv.get(receivedKey(deliveryId))) === true) {
    await receiveInbound(db, deliveryId);
  }
}

/** Note an outbox failure on the attempt the worker is making. */
export const reportOutboxError: OutboxErrorHandler = (error) => {
  const attempt = attempts.getStore();
  if (attempt != null) attempt.failure = failureOf(error);
};

/** Note that the worker gave up on the attempt it is making. */
export const reportPermanentFailure: OutboxPermanentFailureHandler<unknown> = (
  _ctx,
  values,
) => {
  const attempt = attempts.getStore();
  if (attempt == null) return;
  attempt.permanent =
    values.reason === "http"
      ? failureOf(values.error)
      : { statusCode: null, error: values.error.message, responseBody: null };
};

/**
 * Translate what the worker reported into settlements, in order.  Success is
 * what Fedify reports as sent, and giving up what it measures as `abandoned`.
 * A message held back before sending made no attempt.
 * @returns The settlements to apply to the delivery.
 */
export function queuedSettlements({
  failure,
  permanent,
  sent = false,
  statusCode = null,
  outcomes = [],
}: QueuedAttempt): Settlement[] {
  if (sent) return [{ status: "sent", attempted: true, statusCode }];
  const failed: Settlement[] =
    failure == null
      ? []
      : [
          {
            ...failure,
            status:
              permanent == null && outcomes.includes("abandoned")
                ? "abandoned"
                : "failed",
            attempted: true,
          },
        ];
  return permanent == null
    ? failed
    : [
        ...failed,
        { ...permanent, status: "permanently_failed", attempted: false },
      ];
}

/**
 * Whether Fedify reported `activitypub.activity.sent` for the inbox, which is
 * what makes a delivery sent: Fedify returns without sending to a recipient it
 * leaves out.
 * @returns Whether the activity was sent to the inbox.
 */
export const reportsSent = (
  spans: readonly ObservedSpan[],
  inboxUrl: string,
): boolean =>
  spans.some(
    (span) =>
      span.name === "activitypub.send_activity" &&
      span.events.some(
        (event) =>
          event.name === "activitypub.activity.sent" &&
          event.attributes["activitypub.inbox.url"] === inboxUrl,
      ),
  );

/**
 * Where a response sends the request it answered.
 * @returns The URLs the next request may have, empty unless it redirects.
 */
const redirection = ({ status, locations }: ObservedResponse) =>
  status >= 300 && status < 400 ? locations : [];

/**
 * The status a delivery ended with: that of the last response from the inbox,
 * or from wherever the inbox redirected the delivery, however many times.
 * @returns The status code, or null when no response came.
 */
export const deliveredStatus = (
  responses: readonly ObservedResponse[],
  inboxUrl: string,
): number | null =>
  responses.reduce<{
    readonly urls: readonly string[];
    readonly status: number | null;
  }>(
    (hop, response) => {
      if (!hop.urls.includes(response.url)) return hop;
      const next = redirection(response);
      return {
        urls: next.length > 0 ? next : hop.urls,
        status: response.status,
      };
    },
    { urls: [inboxUrl], status: null },
  ).status;

async function settleQueued(
  db: Database,
  attempt: QueuedAttempt,
  deliveryId: Uuid | undefined,
): Promise<void> {
  try {
    for (const settlement of queuedSettlements(attempt)) {
      // oxlint-disable-next-line no-await-in-loop
      await settleOutbound(db, {
        ...settlement,
        activityIri: attempt.activityIri,
        inboxUrl: attempt.inboxUrl,
        ...(deliveryId == null ? {} : { id: deliveryId }),
      });
    }
  } catch (error) {
    logger.error("Could not settle a queued delivery: {error}", { error });
  }
}

async function handleInbox(
  db: Database,
  kv: KvStore,
  message: InboxMessage,
  deliveryId: Uuid,
  handler: (message: unknown) => Promise<void> | void,
): Promise<void> {
  const reception = { activityIri: inboxActivityIri(message), deliveryId };
  const { handled } = await receptions.run(reception, () =>
    trackRequest(async () => await handler(message)),
  );
  if (handled) await receive(db, kv, deliveryId);
}

async function handle(
  db: Database,
  kv: KvStore,
  message: unknown,
  handler: (message: unknown) => Promise<void> | void,
): Promise<void> {
  const logged = isInbox(message) ? loggedIn(message) : undefined;
  if (isInbox(message) && logged != null) {
    await handleInbox(db, kv, message, logged, handler);
    return;
  }
  if (!isOutbox(message) || message.activityId == null) {
    await handler(message);
    return;
  }
  const id = loggedIn(message);
  const attempt: QueuedAttempt = {
    activityIri: message.activityId,
    inboxUrl: message.inbox,
    ...(id == null ? {} : { deliveryId: id }),
  };
  try {
    const { spans, outbox, responses } = await attempts.run(attempt, () =>
      trackRequest(async () => await handler(message)),
    );
    attempt.sent = reportsSent(spans, message.inbox);
    attempt.statusCode = deliveredStatus(responses, message.inbox);
    attempt.outcomes = outbox;
  } catch (error) {
    attempt.failure ??= failureOf(error);
    await settleQueued(db, attempt, id);
    throw error;
  }
  await settleQueued(db, attempt, id);
}

function observeQueue(
  db: Database,
  kv: KvStore,
  queue: MessageQueue,
): MessageQueue {
  return new Proxy(queue, {
    get(target, property) {
      // Fedify retries by its own policy, measuring each retry and giving up;
      // a queue retrying by itself would give up without telling anyone.
      if (property === "nativeRetrial") return false;
      if (property === "enqueue") {
        return async (
          message: unknown,
          options?: Parameters<MessageQueue["enqueue"]>[1],
        ) => {
          await target.enqueue(tag(message), options);
        };
      }
      if (property === "enqueueMany" && target.enqueueMany != null) {
        const enqueueMany = target.enqueueMany.bind(target);
        return async (
          messages: readonly unknown[],
          options?: Parameters<MessageQueue["enqueue"]>[1],
        ) => {
          await enqueueMany(messages.map(tag), options);
        };
      }
      if (property === "listen") {
        // Workers outlive whatever request started them; keep them outside it.
        return (
          handler: (message: unknown) => Promise<void> | void,
          options?: Parameters<MessageQueue["listen"]>[1],
        ) =>
          untracked(() =>
            deliveries.exit(() =>
              attempts.exit(() =>
                target.listen(
                  (message) => handle(db, kv, message, handler),
                  options,
                ),
              ),
            ),
          );
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The outbox queue among Fedify's queue options.
 * @returns The queue outgoing activities wait in, if any.
 */
export function outboxQueue(
  queue: FederationQueueOptions | MessageQueue | undefined,
): MessageQueue | undefined {
  return queue == null || ("enqueue" in queue && "listen" in queue)
    ? queue
    : queue.outbox;
}

/**
 * Observe what Fedify's queue workers do with each message: each delivery
 * attempt settles its outbound delivery, and an inbox listener run settles the
 * inbound delivery of the request that enqueued it.  The queues report no
 * native retrial, so that Fedify's own policy retries.  Queues shared among
 * roles stay shared.
 * @returns Queue options to pass to Fedify instead.
 */
export function observeQueues(
  db: Database,
  kv: KvStore,
  queue: FederationQueueOptions | MessageQueue,
): FederationQueueOptions | MessageQueue {
  if ("enqueue" in queue && "listen" in queue) {
    return observeQueue(db, kv, queue);
  }
  const observed = new Map<MessageQueue, MessageQueue>();
  const wrap = (value: MessageQueue) => {
    const known = observed.get(value);
    if (known != null) return known;
    const created = observeQueue(db, kv, value);
    observed.set(value, created);
    return created;
  };
  return Object.fromEntries(
    Object.entries(queue).map(([role, value]) => [
      role,
      value == null ? value : wrap(value as MessageQueue),
    ]),
  ) as FederationQueueOptions;
}
