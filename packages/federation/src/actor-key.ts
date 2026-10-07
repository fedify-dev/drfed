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

// Generation is intentionally outside transactions; call this before opening
// a transaction that will deliver an activity.
// oxlint-disable no-await-in-loop
import { type Database, schema } from "@drfed/models";
import type { LocalActorKey } from "@drfed/models/schema";
import { type Uuid, validateUuid } from "@drfed/models/uuid";
import {
  type Context,
  exportJwk,
  generateCryptoKeyPair,
  importJwk,
} from "@fedify/fedify";
import { getLogger } from "@logtape/logtape";
import { and, eq } from "drizzle-orm";

import { canonicalizeAuthority } from "./origin.ts";

const logger = getLogger(["drfed", "federation", "actor-key"]);
const pending = new WeakMap<Database, Map<string, Promise<CryptoKeyPair[]>>>();
const algorithms = ["RSASSA-PKCS1-v1_5", "Ed25519"] as const;

async function readPairs(rows: LocalActorKey[]): Promise<CryptoKeyPair[]> {
  const result: CryptoKeyPair[] = [];
  for (const type of algorithms) {
    const row = rows.find((entry) => entry.type === type);
    if (row == null) continue;
    const { publicKey, privateKey } = row;
    const fields =
      type === "Ed25519"
        ? (["kty", "crv", "x"] as const)
        : (["kty", "n", "e"] as const);
    if (fields.some((field) => publicKey[field] !== privateKey[field])) {
      throw new Error("Invalid signing key pair.");
    }
    const pair = {
      publicKey: await importJwk(publicKey, "public"),
      privateKey: await importJwk(privateKey, "private"),
    };
    if (
      pair.publicKey.algorithm.name !== type ||
      pair.privateKey.algorithm.name !== type
    ) {
      throw new Error("Invalid signing algorithm.");
    }
    const challenge = new Uint8Array([1]);
    const signature = await crypto.subtle.sign(
      type,
      pair.privateKey,
      challenge,
    );
    if (
      !(await crypto.subtle.verify(type, pair.publicKey, signature, challenge))
    ) {
      throw new Error("Mismatched signing keys.");
    }
    result.push(pair);
  }
  return result;
}

/**
 * Load durable local actor keys, generating missing pairs on first use.
 * Deleted actors retain existing complete pairs for signing their Delete.
 * Invalid persisted pairs fail closed and are never replaced automatically.
 * See the package README's signing key recovery procedure before repairing rows.
 * @returns Persisted pairs, or an empty array for an unavailable actor.
 * The optional generator is a test seam; production uses Fedify's defaults.
 */
export function ensureActorKeyPairs(
  db: Database,
  ctx: Context<unknown>,
  identifier: string,
  generate: typeof generateCryptoKeyPair = generateCryptoKeyPair,
): Promise<CryptoKeyPair[]> {
  if (!validateUuid(identifier)) return Promise.resolve([]);
  let entries = pending.get(db);
  if (entries == null) {
    entries = new Map();
    pending.set(db, entries);
  }
  const key = `${canonicalizeAuthority(ctx.host)}:${identifier}`;
  const existing = entries.get(key);
  if (existing != null) return existing;
  // The shared promise must remain identical for joining callers.
  // oxlint-disable promise/prefer-await-to-then
  const operation = ensure(db, ctx, identifier as Uuid, generate)
    .catch(() => {
      // Drizzle errors include bound JWKs in their message and cause. Never pass
      // those errors to Fedify's logging, tracing, or delivery recorder.
      logger.error("Could not load signing keys for actor {identifier}.", {
        identifier,
      });
      throw new Error("Could not load actor signing keys.");
    })
    .finally(() => {
      entries.delete(key);
    });
  // oxlint-enable promise/prefer-await-to-then
  entries.set(key, operation);
  return operation;
}

async function ensure(
  db: Database,
  ctx: Context<unknown>,
  identifier: Uuid,
  generate: typeof generateCryptoKeyPair,
): Promise<CryptoKeyPair[]> {
  const host = canonicalizeAuthority(ctx.host);
  const actor = await db.query.actors.findFirst({
    where: { id: identifier, localId: { isNotNull: true }, instance: { host } },
  });
  if (actor?.localId == null) return [];
  const rows = await db
    .select()
    .from(schema.localActorKeys)
    .where(eq(schema.localActorKeys.localActorId, actor.localId));
  const stored = await readPairs(rows);
  if (stored.length === 2) return stored;
  if (actor.deleted != null) return [];
  const candidates: (typeof schema.localActorKeys.$inferInsert)[] = [];
  for (const type of algorithms) {
    if (rows.some((row) => row.type === type)) continue;
    const pair = await generate(type);
    candidates.push({
      localActorId: actor.localId,
      type,
      publicKey: await exportJwk(pair.publicKey),
      privateKey: await exportJwk(pair.privateKey),
    });
  }
  const saved = await db.transaction(async (tx) => {
    // Parent first: local_actors deletion cascades to actors in this order.
    const [local] = await tx
      .select({ id: schema.localActors.id })
      .from(schema.localActors)
      .where(eq(schema.localActors.id, actor.localId!))
      .for("key share");
    if (local == null) return [];
    const [current] = await tx
      .select({ deleted: schema.actors.deleted })
      .from(schema.actors)
      .innerJoin(
        schema.instances,
        eq(schema.actors.instanceId, schema.instances.id),
      )
      .where(
        and(
          eq(schema.actors.id, identifier),
          eq(schema.actors.localId, local.id),
          eq(schema.instances.host, host),
        ),
      )
      .for("no key update", { of: schema.actors });
    if (current == null) return [];
    if (current.deleted == null) {
      await tx
        .insert(schema.localActorKeys)
        .values(candidates)
        .onConflictDoNothing();
    }
    return await tx
      .select()
      .from(schema.localActorKeys)
      .where(eq(schema.localActorKeys.localActorId, local.id));
  });
  return saved.length === 2 ? await readPairs(saved) : [];
}
