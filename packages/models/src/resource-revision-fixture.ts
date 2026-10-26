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
import { randomUUID } from "node:crypto";
import process from "node:process";

import { type Database, migrate, relations, schema } from "@drfed/models";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { Client } from "pg";
import postgres from "postgres";

// This service is an isolated, author-owned test cluster.
// oxlint-disable-next-line node/no-process-env
export const revisionPostgresUrl = process.env.DRFED_TEST_POSTGRES_URL;
export const revisionBackends = ["pglite", "postgres"] as const;
export type RevisionBackend = (typeof revisionBackends)[number];

export interface RevisionFixture {
  readonly db: Database;
  readonly url?: string;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: string[],
  ): Promise<{ rows: T[] }>;
}

/**
 * Opens a separate connection to an already isolated PostgreSQL database.
 * @returns The connection, query adapter, and its owned close operation.
 */
export function revisionConnection(url: string): RevisionFixture & {
  close(): Promise<void>;
} {
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  return {
    db: drizzlePostgres({ client, schema, relations }),
    url,
    async query<T extends Record<string, unknown>>(
      statement: string,
      parameters: string[] = [],
    ) {
      const rows = await client.unsafe<T[]>(statement, parameters);
      return { rows: [...rows] };
    },
    close: () => client.end(),
  };
}

/** Runs against a fresh database; it never truncates a shared database. */
export async function withRevisionDatabase(
  backend: RevisionBackend,
  run: (fixture: RevisionFixture) => Promise<void>,
): Promise<void> {
  if (backend === "pglite") {
    const client = new PGlite();
    try {
      await migrate({ credentials: { driver: "pglite", client } });
      await run({
        db: drizzlePglite({ client, schema, relations }),
        query: (statement, parameters) => client.query(statement, parameters),
      });
    } finally {
      await client.close();
    }
    return;
  }
  assert.ok(revisionPostgresUrl, "An isolated PostgreSQL cluster is required.");
  const name = `drfed_revision_${randomUUID().replaceAll("-", "")}`;
  const administrator = new Client({ connectionString: revisionPostgresUrl });
  await administrator.connect();
  let connection: ReturnType<typeof revisionConnection> | undefined;
  try {
    await administrator.query(`CREATE DATABASE "${name}"`);
    const url = new URL(revisionPostgresUrl);
    url.pathname = `/${name}`;
    await migrate({ credentials: { url: url.href } });
    connection = revisionConnection(url.href);
    await run(connection);
  } finally {
    await connection?.close();
    await administrator.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",
      [name],
    );
    await administrator.query(`DROP DATABASE IF EXISTS "${name}"`);
    await administrator.end();
  }
}
