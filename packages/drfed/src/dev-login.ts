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
import { type Database, normalizeEmail } from "@drfed/models";
import { generateLoginChallengeCode } from "@drfed/models/login";
import { loginChallenges } from "@drfed/models/schema";
import { uuidV7 } from "@drfed/models/uuid";

/**
 * Creates a login challenge for an existing account and composes the link
 * that completes it on the web frontend, without sending any mail.  The link
 * follows the verify URL the frontend's sign-in page sends to `loginByEmail`.
 * @param db The database to look the account up in and store the challenge.
 * @param email The email address of the account to log in as.
 * @param origin The web frontend origin that serves the confirmation page.
 * @returns The login link, or `undefined` if no account has the address.
 */
export async function createLoginLink(
  db: Database,
  email: string,
  origin: string,
): Promise<URL | undefined> {
  const account = await db.query.accounts.findFirst({
    where: { email: normalizeEmail(email) },
  });
  if (account == null) return undefined;
  const id = uuidV7();
  const code = generateLoginChallengeCode();
  await db.insert(loginChallenges).values({ id, accountId: account.id, code });
  return new URL(`/confirm/${id}?code=${code}`, origin);
}
