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
import { recordInbound } from "@drfed/models/activity-log";
import { observeKeyVersion } from "@drfed/models/key";
import { type Uuid, validateUuid } from "@drfed/models/uuid";
import {
  type Federation,
  type FederationFetchOptions,
  type KeyCache,
  type KvKey,
  type KvStore,
  type RequestContext,
  type VerifyRequestDetailedResult,
  exportJwk,
  verifyRequestDetailed,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";

import { canonicalizeAuthority } from "../origin.ts";
import { describeActivity, remoteHost } from "./describe.ts";
import { createKeyCache } from "./keycache.ts";

const logger = getLogger(["drfed", "graphql", "activity-log"]);

/**
 * The actual federation response determines whether an activity was accepted.
 * @returns The inbound delivery status.
 */
export function classifyInbound(
  verification: VerifyRequestDetailedResult,
  responseStatus: number,
): "received" | "unverified" | "rejected" {
  if (responseStatus >= 200 && responseStatus < 300) return "received";
  return verification.verified ? "rejected" : "unverified";
}

function signedKeyId(
  verification: VerifyRequestDetailedResult | undefined,
): URL | null {
  if (verification == null) return null;
  if (verification.verified) return verification.key.id;
  return verification.reason.type === "noSignature"
    ? null
    : (verification.reason.keyId ?? null);
}

function verificationError(result: VerifyRequestDetailedResult): string | null {
  if (result.verified) return null;
  const { reason } = result;
  if (reason.type !== "keyFetchError") return reason.type;
  return `keyFetchError: ${"status" in reason.result ? reason.result.status : reason.result.error.name}`;
}

type Loaders = Pick<
  RequestContext<unknown>,
  "documentLoader" | "contextLoader"
>;

async function observeVerification(
  db: Database,
  request: Request,
  keyCache: KeyCache,
  loaders: Loaders,
) {
  const observedKeys = new Map<string, Awaited<ReturnType<KeyCache["get"]>>>();
  const observedCache: KeyCache = {
    ...keyCache,
    async get(id) {
      const key = await keyCache.get(id);
      observedKeys.set(id.href, key);
      return key;
    },
    async set(id, key) {
      observedKeys.set(id.href, key);
      await keyCache.set(id, key);
    },
  };
  let verification: VerifyRequestDetailedResult | undefined;
  let verificationKeyId: Uuid | null = null;
  // Capture key material before Fedify or another request can refresh the cache.
  try {
    verification = await verifyRequestDetailed(request, {
      keyCache: observedCache,
      ...loaders,
    });
    const key = verification.verified
      ? verification.key
      : verification.reason.type === "invalidSignature" &&
          verification.reason.keyId != null
        ? observedKeys.get(verification.reason.keyId.href)
        : null;
    const keyId = verification.verified
      ? verification.key.id
      : verification.reason.type === "noSignature"
        ? null
        : verification.reason.keyId;
    if (key?.publicKey != null && keyId != null) {
      verificationKeyId = (
        await observeKeyVersion(db, {
          iri: keyId.href,
          publicKey: await exportJwk(key.publicKey),
        })
      ).id;
    }
  } catch (error) {
    logger.error("Could not observe inbox verification: {error}", {
      error,
    });
  }
  return { verification, verificationKeyId };
}

async function findRecordingInstance(db: Database, host: string) {
  try {
    return await db.query.instances.findFirst({
      where: {
        host: canonicalizeAuthority(host),
        localId: { isNotNull: true },
      },
    });
  } catch (error) {
    logger.error("Could not resolve the inbox recording instance: {error}", {
      error,
    });
    return undefined;
  }
}

/**
 * Wrap inbox POSTs while preserving Fedify responses even when recording fails.
 * @returns A fetch handler that records inbox observations.
 */
export function createInboundRecorder({
  db,
  federation,
  kv,
  publicKeyPrefix,
}: {
  readonly db: Database;
  readonly federation: Federation<unknown>;
  readonly kv: KvStore;
  readonly publicKeyPrefix?: KvKey;
}): {
  fetch(
    request: Request,
    options: FederationFetchOptions<unknown>,
  ): Promise<Response>;
} {
  return {
    async fetch(request, options) {
      const ctx = federation.createContext(request, options.contextData);
      const route = ctx.parseUri(new URL(request.url));
      if (request.method !== "POST" || route?.type !== "inbox") {
        return await federation.fetch(request, options);
      }
      // Unclaimed subdomains must not create orphaned public-key history.
      const instance = await findRecordingInstance(db, ctx.host);
      if (instance == null) return await federation.fetch(request, options);
      let payload: unknown;
      try {
        payload = await request.clone().json();
      } catch {
        return await federation.fetch(request, options);
      }
      const loaders = {
        documentLoader: ctx.documentLoader,
        contextLoader: ctx.contextLoader,
      };
      const keyCache = createKeyCache(kv, publicKeyPrefix, loaders);
      const { verification, verificationKeyId } = await observeVerification(
        db,
        request,
        keyCache,
        loaders,
      );
      const response = await federation.fetch(request, options);
      try {
        const actor =
          route.identifier != null && validateUuid(route.identifier)
            ? await db.query.actors.findFirst({
                where: {
                  id: route.identifier,
                  instanceId: instance.id,
                  localId: { isNotNull: true },
                },
              })
            : null;
        const signedKeyIri = signedKeyId(verification)?.href ?? null;
        const description = await describeActivity(payload, loaders);
        await recordInbound(db, {
          ...description,
          instanceId: instance.id,
          actorId: actor?.id ?? null,
          status:
            verification == null
              ? response.ok
                ? "received"
                : "unverified"
              : classifyInbound(verification, response.status),
          signedKeyIri,
          verificationKeyId,
          remoteHost: remoteHost(description.remoteActorIri, signedKeyIri),
          inboxUrl: request.url,
          statusCode: response.status,
          error:
            verification == null
              ? "Verification observation failed"
              : verificationError(verification),
          payload,
        });
      } catch (error) {
        logger.error("Could not record inbox activity: {error}", { error });
      }
      return response;
    },
  };
}
