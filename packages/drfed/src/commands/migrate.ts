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

import process from "node:process";

import { backfillExpansions } from "@drfed/federation/expansion-backfill";
import { MigrationPreparationError, PgliteStoreError } from "@drfed/models";
import { text } from "@optique/core/message";
import { printError, run } from "@optique/run";

import metadata from "../../package.json" with { type: "json" };
import { openDatabaseRuntime } from "../database-runtime.ts";
import { OperationRegistry } from "../operations.ts";
import { ResourceOwner } from "../resources.ts";
import {
  createMigrationProgram,
  describeMigrationConfiguration,
  resolveMigrationOptions,
} from "./migrate-program.ts";

/** Run the installed database preparation command without server resources. */
export async function main(): Promise<void> {
  const invocation = createMigrationProgram();
  let options: ReturnType<typeof resolveMigrationOptions>;
  try {
    const raw = await run(invocation.program, {
      contexts: invocation.contexts,
      contextOptions: { load: (parsed) => invocation.load(parsed) },
      help: "option",
      completion: "both",
      showChoices: true,
      showDefault: true,
      version: { option: true, value: metadata.version },
    });
    options = resolveMigrationOptions(raw);
  } catch (error) {
    printError([
      text(
        error instanceof Error
          ? error.message
          : "Could not resolve configuration.",
      ),
    ]);
    process.exitCode = 1;
    return;
  }
  if (options.printConfig) {
    console.log(
      JSON.stringify(describeMigrationConfiguration(options), null, 2),
    );
    return;
  }
  const owner = new ResourceOwner();
  const operations = new OperationRegistry();
  let interrupted = false;
  let failed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    if (interrupted) process.exit(1);
    interrupted = true;
    failed = true;
    operations.abort();
    deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const database = await operations.run((signal) =>
      openDatabaseRuntime(
        { ...options.database, migrate: !options.check },
        owner,
        options.check ? "inspect" : "apply",
        signal,
      ),
    );
    let expansions: Awaited<ReturnType<typeof backfillExpansions>> | undefined;
    if (options.expandRevisions && database.state.status === "ready") {
      expansions = await operations.run((signal) =>
        backfillExpansions(database.db, { signal }),
      );
    }
    console.log(
      JSON.stringify(
        {
          command: "migrate",
          ...database.state,
          ...(expansions === undefined ? {} : { expansions }),
        },
        null,
        2,
      ),
    );
    if (database.state.status !== "ready") failed = true;
  } catch (error) {
    const cleanAbort =
      interrupted &&
      (error === operations.signal.reason ||
        (error instanceof MigrationPreparationError &&
          error.code === "aborted" &&
          !error.cleanupFailed));
    if (!cleanAbort) {
      const message =
        error instanceof MigrationPreparationError ||
        error instanceof PgliteStoreError
          ? `${error.code}: ${error.message}`
          : "Could not prepare or inspect the database.";
      printError([text(message)]);
      failed = true;
    }
  } finally {
    operations.abort();
    await operations.drain();
    try {
      await owner.close();
    } catch {
      printError([text("Could not cleanly close the database.")]);
      failed = true;
    }
    if (deadline !== undefined) clearTimeout(deadline);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
  process.exitCode = failed ? 1 : 0;
}
