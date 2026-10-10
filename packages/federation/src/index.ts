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
  type FederationBuilder,
  type FederationOptions,
  createFederationBuilder,
} from "@fedify/fedify";
import { metrics, trace } from "@opentelemetry/api";

import { markQueued } from "./activity-delivery/outbound.ts";
import {
  observeQueues,
  outboxQueue,
  reportOutboxError,
  reportPermanentFailure,
} from "./activity-delivery/queue.ts";
import { trackMetrics, trackSpans } from "./activity-delivery/telemetry.ts";
import {
  type TrackedFederation,
  attachKv,
} from "./activity-delivery/tracking.ts";
import { attachActorKeyTask, registerActorKeyTask } from "./actor-key-task.ts";
import { registerActorDispatcher } from "./actor.ts";
import { registerCollectionDispatchers } from "./collection.ts";
import { registerInboxListeners } from "./inbox.ts";
import { registerObjectDispatchers } from "./object-dispatchers.ts";

export { createInboundRecorder } from "./activity-delivery/inbound.ts";
export type { TrackedFederation } from "./activity-delivery/tracking.ts";
export { enqueueActorKeyGeneration } from "./actor-key-task.ts";
export { deliverActivity } from "./activity-delivery/outbound.ts";

/**
 * Creates a `FederationBuilder` with every ActivityPub dispatcher and
 * listener that DrFed serves registered on it.  The registered paths define
 * the URI layout of the federated objects, which makes the object URI getters
 * (e.g. `Context.getActorUri()`) available once the builder is built.
 * @param db The database to resolve local actors from.
 * @returns A builder that has not been built yet.
 */
export function buildFederation(db: Database): FederationBuilder<unknown> {
  const builder = createFederationBuilder<unknown>();
  registerActorDispatcher(builder, db);
  registerActorKeyTask(builder, db);
  registerInboxListeners(builder, db);
  registerObjectDispatchers(builder, db);
  registerCollectionDispatchers(builder, db);
  builder.setOutboxPermanentFailureHandler(reportPermanentFailure);
  return builder;
}

/**
 * Creates a `Federation` instance with every DrFed dispatcher registered.
 * Every registration happens on a fresh builder inside this function, so the
 * returned instance is complete and must not be mutated further.
 * The queues, if any, are observed so that each delivery attempt settles its
 * outbound delivery and each queued inbox listener run its inbound delivery.
 * The inbox completion report supplies verification evidence to
 * `createInboundRecorder()`. Outbound spans and measurements remain tracked.
 * @param db The database to resolve local actors from.
 * @param options Options for the underlying Fedify `Federation`, such as
 *                the `kv` store.
 * @returns The built `Federation` instance.
 */
export default async function createFederation(
  db: Database,
  options: FederationOptions<unknown>,
): Promise<TrackedFederation> {
  const builder = buildFederation(db);
  const federation = await builder.build({
    ...options,
    tracerProvider: trackSpans(
      options.tracerProvider ?? trace.getTracerProvider(),
    ),
    meterProvider: trackMetrics(
      options.meterProvider ?? metrics.getMeterProvider(),
    ),
    ...(options.queue == null
      ? {}
      : { queue: observeQueues(db, options.kv, options.queue) }),
    async onOutboxError(error, activity) {
      await reportOutboxError(error, activity);
      await options.onOutboxError?.(error, activity);
    },
  });
  if (outboxQueue(options.queue) != null) markQueued(federation);
  attachKv(federation, options.kv);
  attachActorKeyTask(
    builder,
    federation,
    options.queue != null &&
      "task" in options.queue &&
      options.queue.task != null,
  );
  return federation as TrackedFederation;
}
