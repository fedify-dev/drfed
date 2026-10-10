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
  linkInboundActivity,
  recordInbound,
} from "@drfed/models/activity-delivery";
import type {
  ActivityDeliveryVerificationResult,
  Instance,
} from "@drfed/models/schema";
import { type Uuid, uuidV7, validateUuid } from "@drfed/models/uuid";
import type { FederationFetchOptions } from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";

import { canonicalizeAuthority, instanceUrl } from "../origin.ts";
import { addressedIris, findAddressedActors } from "./addressing.ts";
import { describeParsed, parseActivity, remoteHost } from "./describe.ts";
import { describeError, receivedMeanwhile } from "./queue.ts";
import {
  type Report,
  type TrackedFederation,
  kvOf,
  trackSettled,
  unwrap,
} from "./tracking.ts";
import { observeVerification } from "./verification.ts";

const logger = getLogger(["drfed", "federation", "activity-delivery"]);

type InboundStatus = "received" | "acknowledged" | "unverified" | "rejected";

/**
 * The actual federation response determines whether an activity was accepted.
 * @param statusCode Null when handling threw instead of answering.
 * @returns The inbound delivery status.
 */
export function classifyInbound({
  statusCode,
  handled,
  verificationResult,
}: {
  readonly statusCode: number | null;
  readonly handled: boolean;
  readonly verificationResult: ActivityDeliveryVerificationResult;
}): InboundStatus {
  if (statusCode != null && statusCode >= 200 && statusCode < 300) {
    return handled ? "received" : "acknowledged";
  }
  return verificationResult === "verified" ? "rejected" : "unverified";
}

/**
 * Drop `cookie`, and reduce non-`Signature` `authorization` to its scheme.
 * @returns The headers as `[name, value]` pairs.
 */
export function recordedHeaders(headers: Headers): [string, string][] {
  return [...headers]
    .filter(([name]) => name !== "cookie")
    .map(([name, value]): [string, string] => {
      if (name !== "authorization") return [name, value];
      const [scheme = ""] = value.trim().split(/\s+/u);
      return [name, scheme.toLowerCase() === "signature" ? value : scheme];
    });
}

/**
 * Parse a body from its octets.
 * @returns The parsed value, or undefined when the body is not JSON.
 */
export function parseBody(body: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return value;
  } catch {
    return undefined;
  }
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

async function readBody(request: Request): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await request.clone().arrayBuffer());
  } catch (error) {
    logger.error("Could not read the inbox request body: {error}", { error });
    return undefined;
  }
}

async function readResponseBody(response: Response): Promise<string | null> {
  try {
    return await response.clone().text();
  } catch (error) {
    logger.error("Could not read the inbox response body: {error}", { error });
    return null;
  }
}

/**
 * Wrap inbox POSTs while preserving Fedify responses even when recording fails.
 * A request Fedify throws on is recorded too, and the exception thrown again.
 * The federation must come from `createFederation()`, which lets the recorder
 * see how Fedify verified each request and with which public key.
 * @returns A fetch handler that records inbox observations.
 */
export function createInboundRecorder({
  db,
  federation,
  rootOrigin,
}: {
  readonly db: Database;
  readonly federation: TrackedFederation;
  readonly rootOrigin: URL;
}): {
  fetch(
    request: Request,
    options: FederationFetchOptions<unknown>,
  ): Promise<Response>;
} {
  async function record(
    request: Request,
    instance: Instance,
    identifier: string | undefined,
    observed: {
      readonly id: Uuid;
      readonly body: Uint8Array;
      readonly payload: unknown;
      readonly report: Pick<Report, "inboxReport">;
      readonly outcome: PromiseSettledResult<Response>;
      readonly handled: boolean;
      readonly loaders: Parameters<typeof parseActivity>[1];
      readonly created: Temporal.Instant;
      readonly completed: Temporal.Instant;
    },
  ): Promise<void> {
    const {
      id,
      body,
      payload,
      report,
      outcome,
      handled,
      loaders,
      created,
      completed,
    } = observed;
    const response = outcome.status === "fulfilled" ? outcome.value : null;
    const statusCode = response?.status ?? null;
    const verification = await observeVerification(
      db,
      request.headers,
      report.inboxReport,
    );
    const owner =
      identifier != null && validateUuid(identifier)
        ? await db.query.actors.findFirst({
            where: {
              id: identifier,
              instanceId: instance.id,
              localId: { isNotNull: true },
            },
          })
        : null;
    const activity =
      payload === undefined ? null : await parseActivity(payload, loaders);
    const description = await describeParsed(payload, activity, loaders);
    const status = classifyInbound({
      statusCode,
      handled,
      verificationResult: verification.result,
    });
    const responseBody =
      response == null ? null : await readResponseBody(response);
    await recordInbound(db, {
      ...description,
      id,
      instanceId: instance.id,
      actorId: owner?.id ?? null,
      addressed: await findAddressedActors(
        db,
        instance.id,
        addressedIris(activity),
      ),
      status,
      verificationMechanism: verification.mechanism,
      verificationResult: verification.result,
      signedKeyIri: verification.signedKeyIri,
      verificationKeyId: verification.keyId,
      remoteHost: remoteHost(
        description.remoteActorIri,
        verification.signedKeyIri,
      ),
      inboxUrl:
        owner?.inboxUrl ??
        instanceUrl(rootOrigin, instance.host, new URL(request.url).pathname)
          .href,
      requestUrl: request.url,
      headers: recordedHeaders(request.headers),
      body,
      statusCode,
      responseBody,
      error:
        outcome.status === "rejected"
          ? describeError(outcome.reason)
          : verification.result === "unobserved"
            ? verification.detail
            : status === "unverified" || status === "rejected"
              ? (verification.detail ?? (responseBody || null))
              : null,
      payload,
      created,
      completed,
    });
    // A queue worker may have run the inbox listener before this was recorded.
    const kv = kvOf(federation);
    if (status === "acknowledged" && kv != null) {
      await receivedMeanwhile(db, kv, id);
    }
    // A listener stores the activity before Fedify answers; a queue worker
    // that runs after this links the delivery itself.
    await linkInboundActivity(db, id);
  }

  return {
    async fetch(request, options) {
      // Arrival, not insertion, orders the deliveries: requests may finish out
      // of order.
      const created = Temporal.Now.instant();
      if (request.method !== "POST") {
        return await federation.fetch(request, options);
      }
      const ctx = federation.createContext(request, options.contextData);
      const route = ctx.parseUri(new URL(request.url));
      if (route?.type !== "inbox") {
        return await federation.fetch(request, options);
      }
      // Unclaimed subdomains must not create orphaned public-key history.
      const instance = await findRecordingInstance(db, ctx.host);
      const body = instance == null ? undefined : await readBody(request);
      if (instance == null || body == null) {
        return await federation.fetch(request, options);
      }
      const loaders = {
        documentLoader: ctx.documentLoader,
        contextLoader: ctx.contextLoader,
      };
      const payload = parseBody(body);
      // Fedify reports how it verified the request as it handles it; nothing
      // is verified again, so the delivery shows Fedify's outcome and keys.
      // Chosen now, so that a queued inbox message can name the delivery.
      const id = uuidV7();
      const { outcome, handled, ...report } = await trackSettled(
        () => federation.fetch(request, options),
        { inboundDeliveryId: id, receipt: { payload, received: created } },
      );
      const completed = Temporal.Now.instant();
      try {
        await record(request, instance, route.identifier, {
          id,
          body,
          payload,
          report,
          outcome,
          handled,
          loaders,
          created,
          completed,
        });
      } catch (error) {
        logger.error("Could not record inbox activity: {error}", { error });
      }
      return unwrap(outcome);
    },
  };
}
