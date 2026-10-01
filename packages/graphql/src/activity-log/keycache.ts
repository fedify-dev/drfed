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

import type {
  FetchKeyErrorResult,
  KeyCache,
  KvKey,
  KvStore,
} from "@fedify/fedify";
import { CryptographicKey, Multikey } from "@fedify/vocab";

import type { ObservedKeyFetch } from "./tracking.ts";

type Loaders = Parameters<typeof CryptographicKey.fromJsonLd>[1];
type DiagnosticKeyCache = KeyCache & {
  getFetchError(keyId: URL): Promise<FetchKeyErrorResult | undefined>;
  setFetchError(
    keyId: URL,
    error: FetchKeyErrorResult | undefined,
  ): Promise<void>;
};
const unavailableTtl = Temporal.Duration.from({ minutes: 10 });

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
  const errorKey = (id: URL): KvKey => [...prefix, "__fetchError", id.href];
  return {
    async get(keyId) {
      const value = await kv.get([...prefix, keyId.href]);
      if (value == null) return value;
      const key = await parseKey(value, options);
      if (key == null) await kv.delete([...prefix, keyId.href]);
      return key;
    },
    async set(keyId, key) {
      await kv.set(
        [...prefix, keyId.href],
        key == null ? null : await key.toJsonLd(options),
        key == null ? { ttl: unavailableTtl } : undefined,
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
  };
}

/**
 * The key a verification used, out of the key fetches `trackRequest()`
 * reported of it: the last its public-key cache entry held while a fetch
 * brought a key, even one fetched again, and even when fetching it again then
 * failed and emptied the entry.  What a fetch read but could not use does not
 * count, nor what another verification of the request found under the IRI.
 * @param fetches The key fetches of the one verification, in order.
 * @returns The key, or null when no fetch brought one.
 */
export async function trackedKey(
  fetches: readonly ObservedKeyFetch[],
  keyIri: string,
  options: Loaders = {},
): Promise<CryptographicKey | Multikey | null> {
  const entry = JSON.stringify([keyIri]);
  const brought = await Promise.all(
    fetches
      .filter(({ result }) => result === "hit" || result === "fetched")
      .flatMap(({ keys }) => keys.get(entry) ?? [])
      .map((value) => (value == null ? undefined : parseKey(value, options))),
  );
  return brought.findLast((key) => key != null) ?? null;
}
