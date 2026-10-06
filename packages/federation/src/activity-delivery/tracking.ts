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
import type { Federation, KvKey, KvStore } from "@fedify/fedify";
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

/** One `activitypub.key.lookup` measurement. */
export interface ObservedKeyLookup {
  /** `hit`, `fetched`, `not_found`, `invalid`, `network_error`, or `error`. */
  readonly result: string;
  /** The status the server of the key answered with, if it answered. */
  readonly statusCode: number | null;
}

/** One `activitypub.signature.key_fetch.duration` measurement. */
export interface ObservedKeyFetch {
  /** `hit`, `fetched`, or `error` when no usable key came back. */
  readonly result: string;
  /** The lookup Fedify counted for the fetch, which tells why it failed. */
  readonly lookup: ObservedKeyLookup | null;
  /**
   * Every value each public-key cache entry held while Fedify made the fetch,
   * in order, by its key below the prefix, as JSON: what it read, then what it
   * wrote.  The last of a fetch that brought a key is the key it brought.
   */
  readonly keys: ReadonlyMap<string, readonly unknown[]>;
}

/** One `activitypub.signature.verification.duration` measurement. */
export interface ObservedVerification {
  /** `http`, `linked_data`, or `object_integrity`. */
  readonly kind: string;
  /** `verified`, `rejected`, `missing`, or `error`. */
  readonly result: string;
  /**
   * The key fetches Fedify measured while verifying, in order, which hold the
   * keys this verification used, and no other.  It fetches a key again when
   * the cached one did not verify.
   */
  readonly keyFetches: readonly ObservedKeyFetch[];
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
  readonly verifications: readonly ObservedVerification[];
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
  /**
   * The values public-key cache entries held since Fedify last measured a key
   * fetch, which the next measurement takes as those of its fetch.
   */
  keys: Map<string, readonly unknown[]>;
  readonly spans: ObservedSpan[];
  readonly verifications: ObservedVerification[];
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
 * spans, measurements and responses it reported, with the values public-key
 * cache entries held at each key fetch it measured, even when the run throws.
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
    keys: new Map(),
    spans: [],
    verifications: [],
    outbox: [],
    responses: [],
  };
  const [outcome] = await Promise.allSettled([
    storage.run(state, async () => await run()),
  ]);
  state.closed = true;
  const { handled, spans, verifications, outbox, responses } = state;
  return { outcome, handled, spans, verifications, outbox, responses };
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

const below = (key: KvKey, prefix: KvKey): string | null =>
  key.length > prefix.length &&
  prefix.every((part, index) => key[index] === part)
    ? JSON.stringify(key.slice(prefix.length))
    : null;

/**
 * Let `trackRequest()` see the public keys Fedify reads and writes, which are
 * the keys it verifies with, including those it fetches again.  `trackMetrics()`
 * tells which key fetch, and so which verification, each belongs to.
 * @returns The same store, tracking entries under `prefix`.
 */
export function trackPublicKeys(kv: KvStore, prefix: KvKey): KvStore {
  const note = (key: KvKey, value: unknown) => {
    const entry = below(key, prefix);
    const keys = tracking()?.keys;
    if (entry != null) keys?.set(entry, [...(keys.get(entry) ?? []), value]);
  };
  return new Proxy(kv, {
    get(target, property) {
      if (property === "get") {
        return async (key: KvKey) => {
          const value = await target.get(key);
          note(key, value);
          return value;
        };
      }
      if (property === "set") {
        return async (
          key: KvKey,
          value: unknown,
          options?: Parameters<KvStore["set"]>[2],
        ) => {
          await target.set(key, value, options);
          note(key, value);
        };
      }
      if (property === "delete") {
        return async (key: KvKey) => {
          await target.delete(key);
          note(key, undefined);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
