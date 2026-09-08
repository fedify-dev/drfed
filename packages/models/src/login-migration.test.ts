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
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { migrate } from "@drfed/models/migrate";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as migrateBaseline } from "drizzle-orm/pglite/migrator";

const migrationName = "20260908065945_simplify_login_challenges";
const migrations = join(
  dirname(fileURLToPath(import.meta.resolve("@drfed/models/migrate"))),
  "..",
  "drizzle",
);

// oxlint-disable-next-line max-statements -- Keep the migration before/after assertions together.
it("upgrades hashed challenges while preserving accounts and sessions", async () => {
  const baseline = await mkdtemp(join(tmpdir(), "drfed-login-migration-"));
  const client = new PGlite();
  try {
    const entries = await readdir(migrations, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name < migrationName)
        .map((entry) =>
          cp(join(migrations, entry.name), join(baseline, entry.name), {
            recursive: true,
          }),
        ),
    );
    await migrateBaseline(drizzle({ client }), { migrationsFolder: baseline });
    const accountId = uuidV7();
    const sessionId = uuidV7();
    await client.query(
      "INSERT INTO accounts (id, email, name) VALUES ($1, $2, $3)",
      [accountId, "migration@example.com", "Migration"],
    );
    await client.query(
      'INSERT INTO sessions (id, "accountId", "tokenHash") VALUES ($1, $2, $3)',
      [sessionId, accountId, "a".repeat(64)],
    );
    await client.query(
      'INSERT INTO login_challenges (id, "accountId", "tokenHash", "codeHash") VALUES ($1, $2, $3, $4)',
      [uuidV7(), accountId, "b".repeat(64), "c".repeat(64)],
    );
    const accounts = (await client.query("SELECT * FROM accounts")).rows;
    const sessions = (await client.query("SELECT * FROM sessions")).rows;
    await migrate({ credentials: { driver: "pglite", client } });
    assert.deepEqual(
      (await client.query("SELECT * FROM accounts")).rows,
      accounts,
    );
    assert.deepEqual(
      (await client.query("SELECT * FROM sessions")).rows,
      sessions,
    );
    assert.deepEqual(
      (await client.query("SELECT * FROM login_challenges")).rows,
      [],
    );
    const id = uuidV7();
    await client.query(
      'INSERT INTO login_challenges (id, "accountId", code) VALUES ($1, $2, $3)',
      [id, accountId, "abc123"],
    );
    const row = (
      await client.query<Record<string, unknown>>(
        "SELECT * FROM login_challenges WHERE id = $1",
        [id],
      )
    ).rows[0];
    assert.ok(row);
    assert.equal(row.code, "abc123");
    assert.equal("tokenHash" in row, false);
    assert.equal("codeHash" in row, false);
    // A second startup must not clear newly issued challenges.
    await migrate({ credentials: { driver: "pglite", client } });
    assert.equal(
      (await client.query("SELECT * FROM login_challenges")).rows.length,
      1,
    );
  } finally {
    await client.close();
    await rm(baseline, { recursive: true, force: true });
  }
});
