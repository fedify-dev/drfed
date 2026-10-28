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
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { type Database, migrate, relations, schema } from "@drfed/models";
import { preparePostgresDatabase } from "@drfed/models/migration-session";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePgliteBaseline } from "drizzle-orm/pglite/migrator";
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
  upgrade(): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly (string | boolean | null)[],
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
    upgrade: () => migrate({ credentials: { url } }),
    async query<T extends Record<string, unknown>>(
      statement: string,
      parameters: readonly (string | boolean | null)[] = [],
    ) {
      const rows = await client.unsafe<T[]>(statement, [...parameters]);
      return { rows: [...rows] };
    },
    close: () => client.end(),
  };
}

interface BaselineFiles {
  readonly directory: string;
  readonly migrationsFolder: string;
  readonly manifestPath: string;
}

async function baselineFiles(beforeMigration: string): Promise<BaselineFiles> {
  const module = import.meta.resolve("@drfed/models/migrate");
  const migrations = fileURLToPath(new URL("../drizzle/", module));
  const manifest = JSON.parse(
    await readFile(new URL("./migrations-manifest.json", module), "utf8"),
  ) as {
    readonly formatVersion: number;
    readonly migrations: readonly {
      readonly name: string;
      readonly sha256: string;
    }[];
  };
  assert.ok(
    manifest.migrations.some((entry) => entry.name === beforeMigration),
  );
  const selected = manifest.migrations.filter(
    (entry) => entry.name < beforeMigration,
  );
  const directory = await mkdtemp(join(tmpdir(), "drfed-revision-baseline-"));
  const migrationsFolder = join(directory, "drizzle");
  const manifestPath = join(directory, "manifest.json");
  try {
    await mkdir(migrationsFolder);
    await Promise.all(
      selected.map((entry) =>
        cp(join(migrations, entry.name), join(migrationsFolder, entry.name), {
          recursive: true,
        }),
      ),
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        formatVersion: manifest.formatVersion,
        migrations: selected,
      }),
    );
    return { directory, migrationsFolder, manifestPath };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function withPgliteRevisionDatabase(
  run: (fixture: RevisionFixture) => Promise<void>,
  baseline?: BaselineFiles,
): Promise<void> {
  const client = new PGlite();
  try {
    const upgrade = () =>
      migrate({ credentials: { driver: "pglite", client } });
    if (baseline === undefined) await upgrade();
    else {
      await migratePgliteBaseline(drizzlePglite({ client }), {
        migrationsFolder: baseline.migrationsFolder,
      });
    }
    await run({
      db: drizzlePglite({ client, schema, relations }),
      upgrade,
      query: (statement, parameters) =>
        client.query(statement, [...(parameters ?? [])]),
    });
  } finally {
    await client.close();
  }
}

async function withPostgresRevisionDatabase(
  run: (fixture: RevisionFixture) => Promise<void>,
  baseline?: BaselineFiles,
): Promise<void> {
  assert.ok(revisionPostgresUrl, "An isolated PostgreSQL cluster is required.");
  const name = `drfed_revision_${randomUUID().replaceAll("-", "")}`;
  const administrator = new Client({ connectionString: revisionPostgresUrl });
  await administrator.connect();
  let connection: ReturnType<typeof revisionConnection> | undefined;
  try {
    await administrator.query(`CREATE DATABASE "${name}"`);
    const url = new URL(revisionPostgresUrl);
    url.pathname = `/${name}`;
    if (baseline === undefined) {
      await migrate({ credentials: { url: url.href } });
    } else {
      await preparePostgresDatabase({
        credentials: { url: url.href },
        migrationsFolder: baseline.migrationsFolder,
        manifestPath: baseline.manifestPath,
      });
    }
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

/** Runs against a fresh database; it never truncates a shared database. */
export async function withRevisionDatabase(
  backend: RevisionBackend,
  run: (fixture: RevisionFixture) => Promise<void>,
  options: { readonly beforeMigration?: string } = {},
): Promise<void> {
  const baseline =
    options.beforeMigration === undefined
      ? undefined
      : await baselineFiles(options.beforeMigration);
  try {
    if (backend === "pglite") await withPgliteRevisionDatabase(run, baseline);
    else await withPostgresRevisionDatabase(run, baseline);
  } finally {
    if (baseline !== undefined) {
      await rm(baseline.directory, { recursive: true, force: true });
    }
  }
}
