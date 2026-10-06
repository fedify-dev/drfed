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

import type { ActivityDeliveryVerificationMechanism } from "@drfed/models/schema";
import type {
  FetchKeyErrorResult,
  KeyCache,
  KvKey,
  KvStore,
} from "@fedify/fedify";
import { CryptographicKey, Multikey } from "@fedify/vocab";

import type { ObservedKeyFetch } from "./tracking.ts";

type Loaders = Parameters<typeof CryptographicKey.fromJsonLd>[1];
type CompatibleKeyScope = "multikey" | "cryptographicKey" | "httpSignature";
interface ScopedKeyCache {
  get(keyId: URL): Promise<CryptographicKey | Multikey | null | undefined>;
  set(
    keyId: URL,
    key: CryptographicKey | Multikey | null,
    options?: { readonly expires?: Temporal.Instant },
  ): Promise<Temporal.Instant | undefined>;
  delete(keyId: URL): Promise<void>;
}
type DiagnosticKeyCache = KeyCache & {
  getFetchError(keyId: URL): Promise<FetchKeyErrorResult | undefined>;
  setFetchError(
    keyId: URL,
    error: FetchKeyErrorResult | undefined,
  ): Promise<void>;
  compatibleKeyScope(scope: CompatibleKeyScope): ScopedKeyCache;
};
// Fedify's KvKeyCache keeps each key below the prefix under this generation,
// and a key at an FEP-ef61 compatible identifier only under this segment,
// apart for each purpose it is looked up for.
const generation = "2";
const compatible = "__compatible";
const keyTtl = Temporal.Duration.from({ days: 30 });
const unavailableTtl = Temporal.Duration.from({ minutes: 10 });
// Fedify caches a key at a compatible identifier for no longer than an hour.
const compatibleKeyTtl = Temporal.Duration.from({ hours: 1 });

/**
 * The purpose Fedify looks a key at a compatible identifier up for, by the
 * mechanism it verifies with, as its `getCompatibleKeyScope()` tells it:
 * Fedify fetches the key of an Object Integrity Proof as a `Multikey`, that
 * of an HTTP signature with portable key resolvers, and that of a Linked Data
 * Signature without.
 */
const compatibleKeyScopes = {
  http_signature: "httpSignature",
  ld_signature: "cryptographicKey",
  object_integrity_proof: "multikey",
} as const satisfies Record<
  ActivityDeliveryVerificationMechanism,
  CompatibleKeyScope
>;

/**
 * Mirror of Fedify's `isCompatibleKeyEntry()`, which is not exported.
 * @returns Whether the value is an entry of a key at a compatible identifier.
 */
const isCompatibleKeyEntry = (
  value: unknown,
): value is { readonly key: unknown; readonly expires: number } =>
  value != null &&
  typeof value === "object" &&
  "key" in value &&
  "expires" in value &&
  typeof value.expires === "number";

async function parseKey(
  value: unknown,
  options: Loaders,
): Promise<CryptographicKey | Multikey | undefined> {
  try {
    return await CryptographicKey.fromJsonLd(value, options);
  } catch {
    try {
      return await Multikey.fromJsonLd(value, options);
    } catch {
      return undefined;
    }
  }
}

/**
 * KV wire format shared with the installed Fedify KvKeyCache.
 * @returns A compatible public-key cache with fetch-error diagnostics.
 */
export function createKeyCache(
  kv: KvStore,
  prefix: KvKey = ["_fedify", "publicKey"],
  options: Loaders = {},
): DiagnosticKeyCache {
  const entryKey = (id: URL): KvKey => [...prefix, generation, id.href];
  const errorKey = (id: URL): KvKey => [...prefix, "__fetchError", id.href];
  return {
    async get(keyId) {
      const value = await kv.get(entryKey(keyId));
      if (value == null) return value;
      const key = await parseKey(value, options);
      if (key == null) await kv.delete(entryKey(keyId));
      return key;
    },
    async set(keyId, key) {
      await kv.set(
        entryKey(keyId),
        key == null ? null : await key.toJsonLd(options),
        { ttl: key == null ? unavailableTtl : keyTtl },
      );
    },
    async getFetchError(keyId) {
      const cached = await kv.get<Record<string, unknown>>(errorKey(keyId));
      if (cached == null || typeof cached !== "object") return undefined;
      if (
        typeof cached.status === "number" &&
        typeof cached.statusText === "string" &&
        Array.isArray(cached.headers) &&
        typeof cached.body === "string"
      ) {
        return {
          status: cached.status,
          response: new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers: cached.headers as [string, string][],
          }),
        };
      }
      if (
        typeof cached.errorName === "string" &&
        typeof cached.errorMessage === "string"
      ) {
        const error = new Error(cached.errorMessage);
        error.name = cached.errorName;
        return { error };
      }
      return undefined;
    },
    async setFetchError(keyId, result) {
      if (result == null) return await kv.delete(errorKey(keyId));
      const value =
        "status" in result
          ? {
              status: result.status,
              statusText: result.response.statusText,
              headers: Array.from(result.response.headers.entries()),
              body: await result.response.clone().text(),
            }
          : {
              errorName: result.error.name,
              errorMessage: result.error.message,
            };
      await kv.set(errorKey(keyId), value, { ttl: unavailableTtl });
    },
    // Fedify keeps the owner a portable actor's document vouched for too,
    // which only a gateway key has, and this does not.
    compatibleKeyScope(scope) {
      const scopedEntry = (id: URL): KvKey => [
        ...prefix,
        compatible,
        scope,
        id.href,
      ];
      return {
        async get(keyId) {
          const entry = await kv.get(scopedEntry(keyId));
          if (entry === undefined) return undefined;
          if (
            !isCompatibleKeyEntry(entry) ||
            entry.expires <= Temporal.Now.instant().epochMilliseconds
          ) {
            await kv.delete(scopedEntry(keyId));
            return undefined;
          }
          if (entry.key === null) return null;
          const key = await parseKey(entry.key, options);
          if (key == null) await kv.delete(scopedEntry(keyId));
          return key;
        },
        async set(keyId, key, { expires } = {}) {
          const now = Temporal.Now.instant();
          const latest = now.add(
            key == null ? unavailableTtl : compatibleKeyTtl,
          );
          const until =
            expires == null || Temporal.Instant.compare(latest, expires) < 0
              ? latest
              : expires;
          const ttl = now.until(until);
          if (ttl.sign <= 0) {
            await kv.delete(scopedEntry(keyId));
            return undefined;
          }
          await kv.set(
            scopedEntry(keyId),
            {
              key: key == null ? null : await key.toJsonLd(options),
              expires: until.epochMilliseconds,
            },
            { ttl },
          );
          return key == null ? undefined : until;
        },
        async delete(keyId) {
          await kv.delete(scopedEntry(keyId));
        },
      };
    },
  };
}

/**
 * The key a verification used, out of the key fetches `trackRequest()`
 * reported of it: the last its public-key cache entry held while a fetch
 * brought a key, even one fetched again, and even when fetching it again then
 * failed and emptied the entry.  What a fetch read but could not use does not
 * count, nor what another verification of the request found under the IRI.
 * A key at an FEP-ef61 compatible identifier is in the entry of the purpose
 * the mechanism looked it up for, whose value wraps the key.
 * @param fetches The key fetches of the one verification, in order.
 * @param mechanism The mechanism of the verification.
 * @returns The key, or null when no fetch brought one.
 */
export async function trackedKey(
  fetches: readonly ObservedKeyFetch[],
  keyIri: string,
  mechanism: ActivityDeliveryVerificationMechanism | null,
  options: Loaders = {},
): Promise<CryptographicKey | Multikey | null> {
  const entry = JSON.stringify([generation, keyIri]);
  const scoped =
    mechanism == null
      ? null
      : JSON.stringify([compatible, compatibleKeyScopes[mechanism], keyIri]);
  const held = ({ keys }: ObservedKeyFetch): readonly unknown[] => [
    ...(keys.get(entry) ?? []),
    ...(scoped == null ? [] : (keys.get(scoped) ?? [])).map((value) =>
      isCompatibleKeyEntry(value) ? value.key : undefined,
    ),
  ];
  const brought = await Promise.all(
    fetches
      .filter(({ result }) => result === "hit" || result === "fetched")
      .flatMap(held)
      .map((value) => (value == null ? undefined : parseKey(value, options))),
  );
  return brought.findLast((key) => key != null) ?? null;
}
