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

import createFederation from "@drfed/federation";
import { type Database, migrate, relations, schema } from "@drfed/models";
import { PGlite } from "@electric-sql/pglite";
import { type Federation, MemoryKvStore } from "@fedify/fedify";
import { drizzle } from "drizzle-orm/pglite";

let databaseSnapshot: Promise<Blob> | undefined;

async function createDatabaseSnapshot(): Promise<Blob> {
  const client = new PGlite();
  try {
    await client.waitReady;
    await migrate({ credentials: { driver: "pglite", client } });
    return await client.dumpDataDir("none");
  } finally {
    await client.close();
  }
}

function getDatabaseSnapshot(): Promise<Blob> {
  databaseSnapshot ??= createDatabaseSnapshot();
  return databaseSnapshot;
}

/**
 * Utilities for testing the federation against a temporary database.
 */
export interface FederationHarness {
  /**
   * The migrated temporary database.
   */
  readonly db: Database;

  /**
   * The federation built from {@link db} with an in-memory KV store.
   */
  readonly federation: Federation<unknown>;
}

/**
 * Runs a callback with a fresh in-memory PGlite database.
 *
 * Each database is restored from a lazily cached, migrated snapshot, so every
 * table in the current `@drfed/models` schema is available.  The underlying
 * PGlite client is closed after the callback resolves or rejects.
 * @param callback A function that receives the migrated database.
 * @returns The callback's resolved value.
 */
export async function withTemporaryDatabase<T>(
  // oxlint-disable-next-line promise/prefer-await-to-callbacks
  callback: (db: Database) => Promise<T> | T,
): Promise<Awaited<T>> {
  const client = new PGlite({ loadDataDir: await getDatabaseSnapshot() });
  try {
    await client.waitReady;
    const db: Database = drizzle({ client, relations, schema });
    // oxlint-disable-next-line promise/prefer-await-to-callbacks
    return await callback(db);
  } finally {
    await client.close();
  }
}

/**
 * Runs a callback with a federation backed by a temporary database.
 * @param callback A function that receives the harness.
 * @returns The callback's resolved value.
 */
export async function withFederation<T>(
  // oxlint-disable-next-line promise/prefer-await-to-callbacks
  callback: (harness: FederationHarness) => Promise<T> | T,
): Promise<Awaited<T>> {
  return await withTemporaryDatabase(async (db) => {
    const federation = await createFederation(db, { kv: new MemoryKvStore() });
    // oxlint-disable-next-line promise/prefer-await-to-callbacks
    return await callback({ db, federation });
  });
}
