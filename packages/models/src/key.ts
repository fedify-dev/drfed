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

import { eq, sql } from "drizzle-orm";

import type { Database } from "./db.ts";
import { type KeyVersion, keyVersions, keys } from "./schema.ts";
import { uuidV7 } from "./uuid.ts";

/** Web Crypto's JWK export type, including optional JOSE metadata. */
export type PublicJwk = Exclude<
  Awaited<ReturnType<SubtleCrypto["exportKey"]>>,
  ArrayBuffer
> & { kid?: string; use?: string };

const privateParameters = [
  "d",
  "p",
  "q",
  "dp",
  "dq",
  "qi",
  "oth",
  "k",
] as const;

/**
 * Reject private/symmetric key material and remove mutable Web Crypto metadata.
 * @returns The public JWK without key_ops and ext.
 */
export function toPublicJwk(jwk: PublicJwk): PublicJwk {
  if (privateParameters.some((name) => name in jwk)) {
    throw new TypeError("Expected an asymmetric public JWK.");
  }
  const { key_ops: _operations, ext: _extractable, ...publicKey } = jwk;
  return publicKey;
}

/**
 * RFC 7638 / RFC 8037 required members in lexicographic order.
 * @returns Canonical JSON for the thumbprint hash.
 */
export function thumbprintInput(jwk: PublicJwk): string {
  const key = toPublicJwk(jwk);
  const required =
    key.kty === "RSA"
      ? // oxlint-disable id-length
        { e: key.e, kty: key.kty, n: key.n }
      : key.kty === "OKP" && key.crv === "Ed25519"
        ? { crv: key.crv, kty: key.kty, x: key.x }
        : null;
  // oxlint-enable id-length
  if (
    required == null ||
    Object.values(required).some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  ) {
    throw new TypeError("Unsupported or incomplete public JWK.");
  }
  return JSON.stringify(required);
}

/**
 * SHA-256 JWK thumbprint, base64url without padding.
 * @returns The public key fingerprint.
 */
export async function jwkThumbprint(jwk: PublicJwk): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(thumbprintInput(jwk)),
  );
  return new Uint8Array(digest).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });
}

/**
 * Observe immutable public key material, reusing a version if a key returns to it.
 * @returns The observed, immutable version with its updated lastSeen.
 */
export async function observeKeyVersion(
  db: Database,
  entry: {
    readonly iri: string;
    readonly publicKey: PublicJwk;
    readonly observed?: Temporal.Instant;
  },
): Promise<KeyVersion> {
  const publicKey = toPublicJwk(entry.publicKey);
  const fingerprint = await jwkThumbprint(publicKey);
  return await db.transaction(async (tx) => {
    await tx
      .insert(keys)
      .values({ id: uuidV7(), iri: entry.iri })
      .onConflictDoNothing({ target: keys.iri });
    const [key] = await tx.select().from(keys).where(eq(keys.iri, entry.iri));
    if (key == null) throw new Error("Missing logical key after insertion.");
    // Take the observation time after serializing competing key insertions.
    const observed = entry.observed ?? Temporal.Now.instant();
    const [version] = await tx
      .insert(keyVersions)
      .values({
        id: uuidV7(),
        keyId: key.id,
        publicKey,
        fingerprint,
        firstSeen: observed,
        lastSeen: observed,
      })
      .onConflictDoUpdate({
        target: [keyVersions.keyId, keyVersions.fingerprint],
        set: {
          lastSeen: sql`greatest(${keyVersions.lastSeen}, excluded.last_seen)`,
        },
      })
      .returning();
    if (version == null) {
      throw new Error("Missing key version after insertion.");
    }
    return version;
  });
}
