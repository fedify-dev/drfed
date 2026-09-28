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

type Loaders = Parameters<typeof CryptographicKey.fromJsonLd>[1];
type DiagnosticKeyCache = KeyCache & {
  getFetchError(keyId: URL): Promise<FetchKeyErrorResult | undefined>;
  setFetchError(
    keyId: URL,
    error: FetchKeyErrorResult | undefined,
  ): Promise<void>;
};
const unavailableTtl = Temporal.Duration.from({ minutes: 10 });

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
      try {
        return await CryptographicKey.fromJsonLd(value, options);
      } catch {
        try {
          return await Multikey.fromJsonLd(value, options);
        } catch {
          await kv.delete([...prefix, keyId.href]);
          return undefined;
        }
      }
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
