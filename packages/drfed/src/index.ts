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
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFile } from "node:fs/promises";
import process from "node:process";

import createFederation, { createInboundRecorder } from "@drfed/federation";
import { KeyGenerationQueue } from "@drfed/federation/task-queue";
import { createYogaServer } from "@drfed/graphql";
import { schema } from "@drfed/graphql/schema";
import { migrate } from "@drfed/models";
import { PgliteKvStore } from "@fedify/pglite";
import { PostgresKvStore } from "@fedify/postgres";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { createLoggingConfig } from "@optique/logtape";
import { run } from "@optique/run";
import { SmtpTransport } from "@upyo/smtp";
import { printSchema } from "graphql";
import { serve } from "srvx";

import metadata from "../package.json" with { type: "json" };
import type {
  Options,
  SchemaGeneratorOptions,
  ServerOptions,
} from "./parser.ts";
import program from "./program.ts";
import seedData from "./seed.ts";
import { createFetchHandler, warnAboutStrandedInstances } from "./serving.ts";

async function runServer(options: ServerOptions) {
  const { credentials } = options.drizzle;
  if (options.drizzle.migrate) await migrate({ credentials });
  if (options.seed) await seedData(options.drizzle.db);
  const kv =
    "driver" in credentials
      ? new PgliteKvStore(credentials.client)
      : new PostgresKvStore(credentials.client);
  const federation = await createFederation(options.drizzle.db, {
    kv,
    queue: { task: new KeyGenerationQueue() },
    taskQueueResolution: "strict",
    manuallyStartQueue: true,
    allowPrivateAddress: true,
  });
  const workerAbort = new AbortController();
  // oxlint-disable promise/prefer-await-to-then
  const worker = federation
    .startQueue(undefined, { queue: "task", signal: workerAbort.signal })
    .catch(() => {
      getLogger(["drfed", "server"]).error(
        "Actor key worker stopped unexpectedly.",
      );
    });
  // oxlint-enable promise/prefer-await-to-then
  const { emailFrom, mailer, rootOrigin, loginOrigins } = options;

  const yogaServer = createYogaServer(options.drizzle.db, federation, {
    rootOrigin,
    emailFrom,
    mailer,
    loginOrigins,
  });
  await warnAboutStrandedInstances(options.drizzle.db, rootOrigin);
  const server = serve({
    fetch: createFetchHandler({
      federation: createInboundRecorder({
        db: options.drizzle.db,
        federation,
        rootOrigin,
      }),
      rootOrigin,
      serveControlSurface: yogaServer.fetch,
    }),
    hostname: options.address.host,
    manual: true,
    gracefulShutdown: false,
    port: options.address.port,
  });
  let closing = false;
  function shutdown() {
    if (closing) {
      process.exit(1);
    }
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    const requests = server.close();
    const forceClose = setTimeout(() => {
      // A stalled upload must not prevent database cleanup on shutdown.
      // oxlint-disable-next-line promise/prefer-await-to-then
      void server.close(true).catch(() => process.exit(1));
    }, 5000);
    workerAbort.abort();
    // The task worker awaits its active handler before resolving.
    // oxlint-disable promise/prefer-await-to-then
    Promise.all([requests, worker])
      .then(async () => {
        clearTimeout(forceClose);
        if (mailer instanceof SmtpTransport) mailer.closeAllConnections();
        await ("driver" in credentials
          ? credentials.client.close()
          : credentials.client.end());
        clearTimeout(deadline);
        process.exit(0);
      })
      .catch(() => {
        process.exit(1);
      });
  }
  // oxlint-enable promise/prefer-await-to-then
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await server.serve();
  } catch (error) {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    workerAbort.abort();
    await Promise.all([server.close(), worker]);
    try {
      if (mailer instanceof SmtpTransport) await mailer.closeAllConnections();
    } catch {
      getLogger(["drfed", "server"]).error(
        "Mailer cleanup after startup failure failed.",
      );
    }
    try {
      await ("driver" in credentials
        ? credentials.client.close()
        : credentials.client.end());
    } catch {
      getLogger(["drfed", "server"]).error(
        "Database cleanup after startup failure failed.",
      );
    }
    throw new Error("Could not start the server.", { cause: error });
  }
}

async function runSchemaGenerator(
  options: SchemaGeneratorOptions,
): Promise<void> {
  const schemaCode = printSchema(schema);
  if (options.outputFile === "-") {
    // oxlint-disable-next-line no-console
    console.log(schemaCode);
    return;
  }
  await writeFile(options.outputFile, schemaCode, { encoding: "utf-8" });
}

export async function main(): Promise<void> {
  const options: Options = run(program, {
    help: "option",
    showChoices: true,
    showDefault: true,
    version: {
      option: true,
      value: metadata.version,
    },
  });
  const loggingConfig = await createLoggingConfig(
    options.logging,
    {},
    {
      contextLocalStorage: new AsyncLocalStorage(),
      sinks: {
        stderr: getConsoleSink({
          levelMap: {
            trace: "error",
            debug: "error",
            info: "error",
            warning: "error",
            error: "error",
            fatal: "error",
          },
        }),
      },
      loggers: [
        {
          category: ["logtape", "meta"],
          lowestLevel: "warning",
          sinks: ["stderr"],
        },
      ],
    },
  );

  await configure(loggingConfig);

  if ("generateGraphqlSchema" in options) {
    await runSchemaGenerator(options);
  } else {
    await runServer(options);
  }
}
