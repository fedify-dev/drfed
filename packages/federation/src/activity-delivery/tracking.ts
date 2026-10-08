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

import type { Uuid } from "@drfed/models/uuid";
import type { Federation, InboxRequestReport, KvStore } from "@fedify/fedify";
import type { Attributes } from "@opentelemetry/api";

/** A span Fedify reported while a tracked run went on. */
export interface ObservedSpan {
  readonly name: string;
  readonly attributes: ReadonlyMap<string, unknown>;
  readonly events: readonly {
    readonly name: string;
    readonly attributes: Readonly<Attributes>;
  }[];
  /** Whether the span ended with an error status. */
  readonly failed: boolean;
}

/** One response `fetch()` received while a tracked run went on. */
export interface ObservedResponse {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  /**
   * The URLs its `Location` header may name, without a fragment: one, or two
   * for a value outside ASCII, which a follower reads as Latin-1 or as UTF-8.
   */
  readonly locations: readonly string[];
}

/** What a tracked run did, besides its result. */
export interface Report {
  /** Whether an inbox listener ran. */
  readonly handled: boolean;
  readonly spans: readonly ObservedSpan[];
  readonly inboxReport: InboxRequestReport | undefined;
  /** `activitypub.outbox.activity` results: `retried`, `abandoned`, ... */
  readonly outbox: readonly string[];
  readonly responses: readonly ObservedResponse[];
}

/** The state of a tracked run, which Fedify's reports add to. */
export interface Tracked {
  /**
   * The inbound delivery the run will be recorded as, known before it exists.
   */
  readonly inboundDeliveryId?: Uuid;
  handled: boolean;
  /** Tasks the run started may outlive it; they must not add to it. */
  closed: boolean;
  inboxReport: InboxRequestReport | undefined;
  readonly spans: ObservedSpan[];
  readonly outbox: string[];
  readonly responses: ObservedResponse[];
}

declare const tracked: unique symbol;

/**
 * A federation made by `createFederation()`, whose reports `trackRequest()`
 * can see.
 */
export type TrackedFederation = Federation<unknown> & {
  readonly [tracked]: true;
};

const federationKv = Symbol("drfed.federationKv");

/** Remember the KV store a federation made by `createFederation()` uses. */
export function attachKv(federation: Federation<unknown>, kv: KvStore): void {
  Object.defineProperty(federation, federationKv, { value: kv });
}

/**
 * The KV store `createFederation()` gave the federation, if it made it.
 * @returns The store, or undefined.
 */
export function kvOf(federation: Federation<unknown>): KvStore | undefined {
  return (federation as { [federationKv]?: KvStore })[federationKv];
}

const storage = new AsyncLocalStorage<Tracked>();

/**
 * The tracked run in progress, if any.
 * @returns Its state, or undefined outside one or after it ended.
 */
export function tracking(): Tracked | undefined {
  const state = storage.getStore();
  return state?.closed === false ? state : undefined;
}

/** Mark the tracked request as having reached an inbox listener. */
export function markHandled(): void {
  const state = tracking();
  if (state != null) state.handled = true;
}

/**
 * Run something that outlives the current tracked run, such as a queue
 * worker, outside it.
 * @returns The result of the run.
 */
export function untracked<T>(run: () => T): T {
  return storage.exit(run);
}

interface TrackOptions {
  readonly inboundDeliveryId?: Uuid;
}

/**
 * Run a federation request or a queued task and report what Fedify did: the
 * inbox report, outbound spans, measurements and responses, even when the
 * run throws.
 * @returns How the run ended, and what was tracked.
 */
export async function trackSettled<T>(
  run: () => Promise<T>,
  { inboundDeliveryId }: TrackOptions = {},
): Promise<{ readonly outcome: PromiseSettledResult<T> } & Report> {
  const state: Tracked = {
    ...(inboundDeliveryId == null ? {} : { inboundDeliveryId }),
    handled: false,
    closed: false,
    inboxReport: undefined,
    spans: [],
    outbox: [],
    responses: [],
  };
  const [outcome] = await Promise.allSettled([
    storage.run(state, async () => await run()),
  ]);
  state.closed = true;
  const { handled, spans, inboxReport, outbox, responses } = state;
  return { outcome, handled, spans, inboxReport, outbox, responses };
}

/**
 * End as a settled run did.
 * @returns The result of the run, unless it threw, which is thrown again.
 */
export function unwrap<T>(outcome: PromiseSettledResult<T>): T {
  if (outcome.status === "rejected") throw outcome.reason;
  return outcome.value;
}

/**
 * Run as `trackSettled()` does, for a caller that needs no report of a run
 * that throws.
 * @returns The result of the run, and what was tracked.
 */
export async function trackRequest<T>(
  run: () => Promise<T>,
  options: TrackOptions = {},
): Promise<{ readonly result: T } & Report> {
  const { outcome, ...report } = await trackSettled(run, options);
  return { result: unwrap(outcome), ...report };
}
