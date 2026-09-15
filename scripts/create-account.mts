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
// oxlint-disable no-console
import process from "node:process";

import { normalizeEmail } from "@drfed/models/email";
import { accounts } from "@drfed/models/schema";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { drizzle } from "drizzle-orm/pglite";

await configure({
  sinks: {
    console: getConsoleSink(),
  },
  loggers: [
    {
      category: ["drfed"],
      lowestLevel: "info",
      sinks: ["console"],
    },
    {
      category: ["logtape", "meta"],
      lowestLevel: "warning",
      sinks: ["console"],
    },
  ],
});

const logger = getLogger(["drfed", "create-account"]);

async function main(): Promise<void> {
  const email = normalizeEmail(process.env.email ?? "");
  const name = (process.env.name ?? "").trim();
  const created = Temporal.Now.instant();
  const accountId = uuidV7();

  if (email.length > 255 || !/^[^@]+@[^@]+\.[^@]+$/u.test(email)) {
    throw new Error("Invalid email address (maximum 255 characters).");
  }
  if (name === "" || name.length > 100) {
    throw new Error("Name must contain 1 to 100 characters.");
  }

  const pgData = ".pgdata";
  const client = new PGlite(pgData);

  try {
    const [account] = await drizzle({ client })
      .insert(accounts)
      .values([
        {
          id: accountId,
          email,
          name,
          created,
        },
      ])
      .onConflictDoNothing({ target: accounts.email })
      .returning({ id: accounts.id });

    if (account) {
      logger.info("Created account {email} {accountId}", {
        email,
        accountId: account.id,
      });
    } else {
      logger.warn("Account already exists");
    }
  } finally {
    await client.close();
  }
}

try {
  await main();
} catch (error) {
  logger.error("Failed to create account: {error}", { error });
  process.exitCode = 1;
}
