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
// oxlint-disable max-classes-per-file -- Keep the related challenge errors together.

import { type SQL, and, eq, gt, isNull, sql } from "drizzle-orm/sql";

import type { Database, Transaction } from "./db.ts";
import { type LoginChallenge, loginChallenges } from "./schema.ts";
import type { Uuid } from "./uuid.ts";

/**
 * An error that occurs when a login challenge operation fails.
 */
export class LoginChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginChallengeError";
  }
}

/**
 * An error that occurs when a login challenge is not found.
 */
export class LoginChallengeNotFoundError extends LoginChallengeError {
  constructor(message: string) {
    super(message);
    this.name = "LoginChallengeNotFoundError";
  }
}

/**
 * Finds a login challenge by its ID, ensuring that it has not been consumed
 * and has not expired. If the login challenge is not found, it throws a
 * {@link LoginChallengeNotFoundError}.
 * @param db The {@link Database} instance to use for the operation.
 *           It can be a {@link Transaction} as well.
 * @param id The UUID of the login challenge to find.
 * @param now An optional timestamp to use for checking expiration.
 *            If not provided, the current timestamp will be used.
 * @returns A promise that resolves to the found {@link LoginChallenge}.
 * @throws {LoginChallengeNotFoundError} if the login challenge is not found
 *                                       or has been consumed or expired.
 */
export async function findLoginChallenge(
  db: Database | Transaction,
  id: Uuid,
  now?: Date | SQL<Date>,
): Promise<LoginChallenge> {
  // oxlint-disable-next-line no-param-reassign
  now ??= sql<Date>`CURRENT_TIMESTAMP`;
  const result = await db.query.loginChallenges.findFirst({
    where: {
      id,
      consumed: { isNull: true },
      ...(now instanceof Date
        ? { expires: { gt: now } }
        : { RAW: (t) => sql`${t.expires} > ${now}` }),
    },
  });
  if (result == null) {
    throw new LoginChallengeNotFoundError("Login challenge not found.");
  }
  return result;
}

/**
 * An error that occurs when consuming a login challenge fails.
 */
export class LoginChallengeConsumptionError extends LoginChallengeError {
  constructor(message: string) {
    super(message);
    this.name = "LoginChallengeConsumptionError";
  }
}

/**
 * Consumes a login challenge by setting its `consumed` timestamp to
 * the current time.
 * @param db The {@link Database} instance to use for the operation.
 *           It can be a {@link Transaction} as well.
 * @param id The UUID of the login challenge to consume.
 * @param now An optional timestamp to set as the `consumed` time.
 *            If not provided, the current timestamp will be used.
 */
export async function consumeLoginChallenge(
  db: Database | Transaction,
  id: Uuid,
  now?: Date | SQL<Date>,
): Promise<void> {
  // oxlint-disable-next-line no-param-reassign
  now ??= sql<Date>`CURRENT_TIMESTAMP`;
  const result = await db
    .update(loginChallenges)
    .set({ consumed: now })
    .where(
      and(
        eq(loginChallenges.id, id),
        isNull(loginChallenges.consumed),
        gt(loginChallenges.expires, now),
      ),
    )
    .returning({ consumed: loginChallenges.consumed });
  if (result.length < 1 || result[0]?.consumed == null) {
    throw new LoginChallengeConsumptionError(
      "Login challenge not found or already consumed.",
    );
  }
}
