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

import { type Uuid, validateUuid } from "@drfed/models/uuid";

/** The server values a preview showed, bound to the request it showed. */
export interface Allocation {
  /** UUIDs by the JSON of each new resource's or generated activity's path. */
  readonly ids: ReadonlyMap<string, Uuid>;
  /** The operation's single timestamp, in microseconds. */
  readonly timestamp: Temporal.Instant;
}

interface Payload {
  readonly v: 1;
  readonly account: string;
  readonly digest: string;
  readonly ids: readonly (readonly [string, string])[];
  readonly timestamp: string;
  readonly expires: number;
}

const TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const encoder = new TextEncoder();

/**
 * Serializes JSON with sorted keys, so that equal requests digest equally.
 * @returns The canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry: unknown) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function sign(key: CryptoKey, text: string): Promise<string> {
  return base64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))),
  );
}

/**
 * Digests what a token binds: the account and the request's canonical JSON.
 * @returns The base64url SHA-256 digest.
 */
export async function digestRequest(request: unknown): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(canonicalJson(request)),
      ),
    ),
  );
}

/**
 * Truncates an instant to the microseconds a timestamptz column keeps.
 * @returns The truncated instant.
 */
export function toMicroseconds(instant: Temporal.Instant): Temporal.Instant {
  return Temporal.Instant.fromEpochNanoseconds(
    (instant.epochNanoseconds / 1000n) * 1000n,
  );
}

/**
 * Signs an allocation for one account and request digest.
 * @returns The preview token.
 */
export async function issueToken(
  key: CryptoKey,
  account: Uuid,
  digest: string,
  allocation: Allocation,
  now = Temporal.Now.instant(),
): Promise<string> {
  const payload: Payload = {
    v: 1,
    account,
    digest,
    ids: [...allocation.ids],
    timestamp: allocation.timestamp.toString(),
    expires: now.epochMilliseconds + TOKEN_LIFETIME_MS,
  };
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${await sign(key, body)}`;
}

/**
 * Verifies a token's signature, lifetime, account and request digest.
 * @returns The allocation it carries, or null when it does not hold.
 */
export async function readToken(
  key: CryptoKey,
  token: string,
  account: Uuid,
  digest: string,
  now = Temporal.Now.instant(),
): Promise<Allocation | null> {
  if (typeof token !== "string") return null;
  const [body, signature, extra] = token.split(".");
  if (body == null || signature == null || extra != null) return null;
  const expected = await sign(key, body);
  // Compare digests, not strings, so that timing reveals nothing.
  const [left, right] = await Promise.all(
    [expected, signature].map((text) =>
      crypto.subtle.digest("SHA-256", encoder.encode(text)),
    ),
  );
  if (Buffer.compare(Buffer.from(left!), Buffer.from(right!)) !== 0) {
    return null;
  }
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    payload?.v !== 1 ||
    payload.account !== account ||
    payload.digest !== digest ||
    typeof payload.expires !== "number" ||
    payload.expires <= now.epochMilliseconds ||
    !Array.isArray(payload.ids) ||
    payload.ids.some(
      (entry) =>
        !Array.isArray(entry) ||
        typeof entry[0] !== "string" ||
        !validateUuid(entry[1]),
    )
  ) {
    return null;
  }
  let timestamp: Temporal.Instant;
  try {
    timestamp = Temporal.Instant.from(payload.timestamp);
  } catch {
    return null;
  }
  return {
    ids: new Map(payload.ids.map(([path, id]) => [path, id as Uuid])),
    timestamp,
  };
}
