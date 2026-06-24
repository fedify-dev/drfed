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
import { createYogaServer } from "@drfed/graphql";
import type { ServerContext, UserContext } from "@drfed/graphql/builder";
import { type Database, migrate, relations, schema } from "@drfed/models";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { YogaServerInstance } from "graphql-yoga";

const testEndpoint = "http://drfed.test/graphql";

/**
 * The `fetch()` function exposed by the test Yoga server.
 */
export type TestFetch = YogaServerInstance<ServerContext, UserContext>["fetch"];

/**
 * A JSON GraphQL request body for {@link TestHarness.post}.
 */
export interface RequestBody {
  /**
   * The GraphQL operation source text.
   */
  readonly query: string;

  /**
   * Variables for the GraphQL operation.
   */
  readonly variables?: Readonly<Record<string, unknown>>;

  /**
   * The operation name to execute when `query` contains multiple operations.
   */
  readonly operationName?: string;
}

/**
 * Utilities for testing the GraphQL server against a temporary database.
 */
export interface TestHarness {
  /**
   * The migrated temporary database.
   */
  readonly db: Database;

  /**
   * The test server's `fetch()` function, bound to the Yoga server instance.
   */
  readonly fetch: TestFetch;

  /**
   * The Yoga server instance under test.
   */
  readonly yoga: YogaServerInstance<ServerContext, UserContext>;

  /**
   * Sends a JSON `POST` request to the test server's GraphQL endpoint.
   *
   * @param body The GraphQL request body.
   * @param init Additional request options.
   * @returns The HTTP response returned by the Yoga server.
   */
  post(body: RequestBody, init?: RequestInit): Promise<Response>;
}

/**
 * Runs a callback with a fresh in-memory PGlite database.
 *
 * The database is migrated before the callback is invoked, so every table in
 * the current `@drfed/models` schema is available.  The underlying PGlite
 * client is closed after the callback resolves or rejects.
 *
 * @example
 * ```ts
 * import assert from "node:assert/strict";
 * import { it } from "node:test";
 *
 * import { schema } from "@drfed/models";
 *
 * import { withTemporaryDatabase } from "./harness.test.ts";
 *
 * it("queries accounts", async () => {
 *   await withTemporaryDatabase(async (db) => {
 *     const accounts = await db.select().from(schema.accounts);
 *     assert.deepEqual(accounts, []);
 *   });
 * });
 * ```
 *
 * @param callback A function that receives the migrated database.
 * @returns The callback's resolved value.
 */
export async function withTemporaryDatabase<T>(
  // oxlint-disable-next-line promise/prefer-await-to-callbacks
  callback: (db: Database) => Promise<T> | T,
): Promise<Awaited<T>> {
  const client = new PGlite();
  try {
    await client.waitReady;
    await migrate({ credentials: { driver: "pglite", client } });
    const db: Database = drizzle({ client, relations, schema });
    // oxlint-disable-next-line promise/prefer-await-to-callbacks
    return await callback(db);
  } finally {
    await client.close();
  }
}

/**
 * Runs a callback with a Yoga server backed by a temporary database.
 *
 * The harness exposes the migrated database for seeding, the Yoga server for
 * lower-level tests, and `post()` for JSON requests.
 *
 * @example
 * ```ts
 * import assert from "node:assert/strict";
 * import { it } from "node:test";
 *
 * import { withTestHarness } from "./harness.test.ts";
 *
 * it("queries the schema", async () => {
 *   await withTestHarness(async ({ post }) => {
 *     const response = await post({ query: "{ __typename }" });
 *
 *     assert.equal(response.status, 200);
 *     assert.deepEqual(await response.json(), {
 *       data: { __typename: "Query" },
 *     });
 *   });
 * });
 * ```
 *
 * @param callback A function that receives the test harness.
 * @returns The callback's resolved value.
 */
export async function withTestHarness<T>(
  // oxlint-disable-next-line promise/prefer-await-to-callbacks
  callback: (harness: TestHarness) => Promise<T> | T,
): Promise<Awaited<T>> {
  return await withTemporaryDatabase(async (db) => {
    const yoga = createYogaServer(db);
    const fetch: TestFetch = yoga.fetch.bind(yoga);

    const harness: TestHarness = {
      db,
      fetch,
      yoga,
      post(body, init) {
        const headers = new Headers(init?.headers);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
        return Promise.resolve(
          fetch(testEndpoint, {
            ...init,
            body: JSON.stringify(body),
            headers,
            method: "POST",
          }),
        );
      },
    };

    // oxlint-disable-next-line promise/prefer-await-to-callbacks
    return await callback(harness);
  });
}
