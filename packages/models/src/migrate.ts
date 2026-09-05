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
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Options, type Sql } from "postgres";

export type MigrateCredentials =
  | PostgresMigrateCredentials
  | PGliteMigrateCredentials;

export type PostgresMigrateCredentials =
  | {
      readonly driver?: never;
      readonly url: string;
      readonly options?: Omit<Options<Record<string, never>>, "max">;
    }
  | {
      readonly driver?: never;
      readonly client: Sql;
    };

export type PGliteMigrateCredentials =
  | {
      readonly driver: "pglite";
      readonly url: string;
      readonly options?: PGliteOptions;
    }
  | {
      readonly driver: "pglite";
      readonly client: PGlite;
    };

export interface MigrateOptions {
  /**
   * PostgreSQL or PGlite credentials.
   */
  readonly credentials: MigrateCredentials;

  /**
   * Custom migrations table/schema.  Equivalent to drizzle-kit config's
   * `migrations` option.
   */
  readonly migrations?: {
    readonly table?: string;
    readonly schema?: string;
  };

  /**
   * Custom migrations table.  Takes precedence over `migrations.table`.
   */
  readonly migrationsTable?: string;

  /**
   * Custom migrations schema.  Takes precedence over `migrations.schema`.
   */
  readonly migrationsSchema?: string;
}

const migrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

export async function migrate(options: MigrateOptions): Promise<void> {
  assertV3MigrationsFolder(migrationsFolder);

  const config = {
    migrationsFolder,
    migrationsSchema:
      options.migrationsSchema ?? options.migrations?.schema ?? "drizzle",
    migrationsTable:
      options.migrationsTable ??
      options.migrations?.table ??
      "__drizzle_migrations",
  };

  if (isPGliteMigrateCredentials(options.credentials)) {
    await migratePGliteDatabase(options.credentials, config);
  } else {
    await migratePostgresDatabase(options.credentials, config);
  }
}

function assertV3MigrationsFolder(migrationsDir: string): void {
  // oxlint-disable-next-line node/no-sync
  if (!existsSync(join(migrationsDir, "meta", "_journal.json"))) {
    return;
  }

  throw new Error(
    `The migrations folder format is outdated: ${migrationsDir}. ` +
      "Run `drizzle-kit up` before using migrate().",
  );
}

function isPGliteMigrateCredentials(
  credentials: MigrateCredentials,
): credentials is PGliteMigrateCredentials {
  return credentials.driver === "pglite";
}

async function migratePGliteDatabase(
  credentials: PGliteMigrateCredentials,
  config: MigrationConfig,
): Promise<void> {
  const client =
    "client" in credentials
      ? credentials.client
      : new PGlite(normalizePGliteUrl(credentials.url), credentials.options);
  const shouldCloseClient = !("client" in credentials);

  try {
    await client.waitReady;
    await migratePglite(drizzlePglite({ client }), config);
  } finally {
    if (shouldCloseClient) {
      await client.close();
    }
  }
}

async function migratePostgresDatabase(
  credentials: PostgresMigrateCredentials,
  config: MigrationConfig,
): Promise<void> {
  const client =
    "client" in credentials
      ? credentials.client
      : postgres(credentials.url, { ...credentials.options, max: 1 });
  const shouldCloseClient = !("client" in credentials);

  try {
    await migratePostgres(drizzlePostgres({ client }), config);
  } finally {
    if (shouldCloseClient) {
      await client.end();
    }
  }
}

function normalizePGliteUrl(url: string): string {
  if (url.startsWith("file:")) {
    return url.slice("file:".length);
  }
  return url;
}

interface MigrationConfig {
  readonly migrationsFolder: string;
  readonly migrationsTable: string;
  readonly migrationsSchema: string;
}
