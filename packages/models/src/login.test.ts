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
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { type Database, migrate, relations, schema } from "@drfed/models";
import {
  LoginChallengeConsumptionError,
  LoginChallengeNotFoundError,
  consumeLoginChallenge,
  findLoginChallenge,
} from "@drfed/models/login";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

const accountId = uuidV7();
const challengeId = uuidV7();
const now = new Date("2026-09-08T00:00:00Z");
const expires = new Date("2026-09-08T00:15:00Z");
let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = new PGlite();
  await migrate({ credentials: { driver: "pglite", client } });
  db = drizzle({ client, schema, relations });
  await db.insert(schema.accounts).values({
    id: accountId,
    email: "login@example.com",
    name: "Login",
  });
  await db.insert(schema.loginChallenges).values({
    id: challengeId,
    accountId,
    tokenHash: "a".repeat(64),
    codeHash: "b".repeat(64),
    created: now,
    expires,
  });
});

afterEach(async () => {
  await client.close();
});

describe("login challenges", () => {
  it("finds an active challenge by its public ID with Date and SQL clocks", async () => {
    assert.equal(
      (await findLoginChallenge(db, challengeId, now)).accountId,
      accountId,
    );
    const clock = sql<Date>`${now.toISOString()}::timestamptz`;
    assert.equal(
      (await findLoginChallenge(db, challengeId, clock)).id,
      challengeId,
    );
  });

  it("rejects missing, expired, and consumed challenges", async () => {
    await assert.rejects(
      findLoginChallenge(db, uuidV7(), now),
      LoginChallengeNotFoundError,
    );
    await assert.rejects(
      findLoginChallenge(db, challengeId, expires),
      LoginChallengeNotFoundError,
    );
    await consumeLoginChallenge(db, challengeId, now);
    await assert.rejects(
      findLoginChallenge(db, challengeId, now),
      LoginChallengeNotFoundError,
    );
  });

  it("consumes an unused challenge exactly once", async () => {
    await consumeLoginChallenge(db, challengeId, now);
    const row = await db.query.loginChallenges.findFirst({
      where: { id: challengeId },
    });
    assert.deepEqual(row?.consumed, now);
    await assert.rejects(
      consumeLoginChallenge(db, challengeId, now),
      LoginChallengeConsumptionError,
    );
  });

  it("does not consume missing or expired challenges", async () => {
    await assert.rejects(
      consumeLoginChallenge(db, uuidV7(), now),
      LoginChallengeConsumptionError,
    );
    await assert.rejects(
      consumeLoginChallenge(db, challengeId, expires),
      LoginChallengeConsumptionError,
    );
    assert.equal(
      (await findLoginChallenge(db, challengeId, now)).consumed,
      null,
    );
  });

  it("allows only one competing consumption to succeed", async () => {
    const results = await Promise.allSettled([
      consumeLoginChallenge(db, challengeId, now),
      consumeLoginChallenge(db, challengeId, now),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const rejected = results.find((r) => r.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof LoginChallengeConsumptionError);
  });

  it("rolls consumption back with its enclosing transaction", async () => {
    const rollback = new Error("Roll back login");
    await assert.rejects(
      db.transaction(async (tx) => {
        await findLoginChallenge(tx, challengeId, now);
        await consumeLoginChallenge(tx, challengeId, now);
        throw rollback;
      }),
      rollback,
    );
    assert.equal(
      (await findLoginChallenge(db, challengeId, now)).consumed,
      null,
    );
  });

  it("uses the database clock by default and accepts an SQL consumption time", async () => {
    await db
      .update(schema.loginChallenges)
      .set({
        expires: sql`CURRENT_TIMESTAMP + INTERVAL '15 minutes'`,
      })
      .where(eq(schema.loginChallenges.id, challengeId));
    await findLoginChallenge(db, challengeId);
    await consumeLoginChallenge(db, challengeId, sql<Date>`CURRENT_TIMESTAMP`);
    await assert.rejects(
      findLoginChallenge(db, challengeId),
      LoginChallengeNotFoundError,
    );
  });

  it("defaults the consumption timestamp to the database clock", async () => {
    await db
      .update(schema.loginChallenges)
      .set({
        expires: sql`CURRENT_TIMESTAMP + INTERVAL '15 minutes'`,
      })
      .where(eq(schema.loginChallenges.id, challengeId));
    await consumeLoginChallenge(db, challengeId);
    const row = await db.query.loginChallenges.findFirst({
      where: { id: challengeId },
    });
    assert.ok(row?.consumed instanceof Date);
  });
});
