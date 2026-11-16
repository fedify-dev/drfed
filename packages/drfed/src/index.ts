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
import type { Database } from "@drfed/models";
import { type WebRuntime, createWebRuntime } from "@drfed/web";
import { PgliteKvStore } from "@fedify/pglite";
import { PostgresKvStore } from "@fedify/postgres";
import {
  configure,
  dispose,
  getConsoleSink,
  getLogger,
} from "@logtape/logtape";
import { text } from "@optique/core/message";
import { createLoggingConfig } from "@optique/logtape";
import { printError, run } from "@optique/run";
import { serve } from "srvx";

import metadata from "../package.json" with { type: "json" };
import { createLoginLink } from "./dev-login.ts";
import { describeServerConfiguration } from "./diagnostics.ts";
import { OperationRegistry } from "./operations.ts";
import {
  type Options,
  type SchemaGeneratorOptions,
  type ServerOptions,
  resolveOptions,
} from "./parser.ts";
import { createProgram, selectInvocationMode } from "./program.ts";
import { ResourceOwner } from "./resources.ts";
import { createServerRuntime } from "./runtime-options.ts";
import seedData from "./seed.ts";
import {
  createControlSurface,
  createFetchHandler,
  getIngressMetadata,
  warnAboutStrandedInstances,
} from "./serving.ts";

async function runServer(configuration: ServerOptions) {
  const owner = new ResourceOwner();
  const operations = new OperationRegistry();
  owner.register(null, () => dispose(), { owned: true });
  let server: ReturnType<typeof serve> | undefined;
  let closing: Promise<void> | undefined;
  let signalled = false;

  async function cleanup(): Promise<void> {
    operations.abort();
    const errors: unknown[] = [];
    let forced: Promise<void> | undefined;
    const forceTimer = setTimeout(() => {
      if (server == null) return;
      const currentServer = server;
      forced = (async () => {
        try {
          await currentServer.close(true);
        } catch (error) {
          errors.push(error);
        }
      })();
    }, 5000);
    try {
      const results = await Promise.allSettled([
        server?.close(),
        operations.drain(),
      ]);
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (forced != null) await forced;
    } finally {
      clearTimeout(forceTimer);
      try {
        await owner.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Server cleanup failed.");
    }
  }

  function stop(): Promise<void> {
    // Assign before invoking abort callbacks so reentrant cleanup is shared.
    // oxlint-disable-next-line promise/prefer-await-to-then
    return (closing ??= Promise.resolve().then(cleanup));
  }

  function shutdown(): void {
    if (signalled) process.exit(1);
    signalled = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    // oxlint-disable promise/prefer-await-to-then
    void stop().then(
      () => {
        clearTimeout(deadline);
        process.exit(0);
      },
      () => process.exit(1),
    );
    // oxlint-enable promise/prefer-await-to-then
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    const options = await operations.run((signal) =>
      createServerRuntime(configuration, owner, signal),
    );
    const { credentials, db } = options.drizzle;
    if (options.seed) await operations.run(() => seedData(db));
    const kv =
      "driver" in credentials
        ? new PgliteKvStore(credentials.client)
        : new PostgresKvStore(credentials.client);
    const federation = await operations.run(() =>
      createFederation(db, {
        kv,
        queue: { task: new KeyGenerationQueue() },
        taskQueueResolution: "strict",
        manuallyStartQueue: true,
        allowPrivateAddress: true,
      }),
    );
    // The registry drains the worker before owned database cleanup.
    void (async () => {
      try {
        await operations.run((signal) =>
          federation.startQueue(undefined, { queue: "task", signal }),
        );
      } catch {
        if (!operations.signal.aborted) {
          getLogger(["drfed", "server"]).error(
            "Actor key worker stopped unexpectedly.",
          );
        }
      }
    })();
    const { emailFrom, mailer, rootOrigin, loginOrigins } = options;
    const yogaServer = createYogaServer(db, federation, {
      rootOrigin,
      emailFrom,
      mailer,
      loginOrigins,
      trackOperation: (operation) => operations.track(operation),
      shutdownSignal: operations.signal,
    });
    await operations.run(() => warnAboutStrandedInstances(db, rootOrigin));
    let web: WebRuntime | undefined;
    if (options.web) {
      const { publicOrigin } = options;
      if (publicOrigin === undefined) {
        throw new Error("Missing public web origin.");
      }
      web = await operations.run(async (signal) => {
        const runtime = owner.register(
          await createWebRuntime({
            publicOrigin,
            graphqlFetch: (request) =>
              operations.track(() => yogaServer.fetch(request)),
          }),
          (resource) => resource.close(),
          { owned: true },
        );
        signal.throwIfAborted();
        return runtime;
      });
    }
    const fetchHandler = createFetchHandler({
      federation: createInboundRecorder({
        db,
        federation,
        rootOrigin,
        ingressMetadata: getIngressMetadata,
      }),
      rootOrigin,
      serveControlSurface: createControlSurface({
        graphql: yogaServer.fetch,
        ...(web === undefined ? {} : { web: web.fetch }),
      }),
    });
    const ownedServer = owner.register(
      serve({
        async fetch(request) {
          if (operations.signal.aborted) {
            return new Response("Server is stopping.", { status: 503 });
          }
          try {
            return await operations.run(() => fetchHandler(request));
          } catch (error) {
            if (operations.signal.aborted) {
              return new Response("Server is stopping.", { status: 503 });
            }
            throw error;
          }
        },
        hostname: options.address.host,
        manual: true,
        gracefulShutdown: false,
        port: options.address.port,
      }),
      (resource) => resource.close(true),
      { owned: true },
    );
    server = ownedServer;
    await operations.run(async () => {
      await ownedServer.serve();
    });
    if (options.publicOrigin !== undefined) {
      getLogger(["drfed", "server"]).info(
        "Web frontend is available at {origin}.",
        { origin: options.publicOrigin.origin },
      );
    }
    const { loginLink } = options;
    if (loginLink !== undefined) {
      await operations.run(() =>
        logLoginLink(db, loginLink.email, loginLink.origin),
      );
    }
  } catch (error) {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    const deadline = Promise.withResolvers<never>();
    const timeout = setTimeout(
      () => deadline.reject(new Error("Startup cleanup timed out.")),
      10_000,
    );
    try {
      await Promise.race([stop(), deadline.promise]);
    } catch {
      throw new Error("Database cleanup after startup failure failed.", {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
    throw new Error("Could not start the server.", { cause: error });
  }
}

async function logLoginLink(
  db: Database,
  email: string,
  origin: string,
): Promise<void> {
  const logger = getLogger(["drfed", "server"]);
  const link = await createLoginLink(db, email, origin);
  if (link === undefined) {
    logger.warn("Cannot create a login link; no account has {email}.", {
      email,
    });
    return;
  }
  logger.info("Log in as {email} at {link}.", { email, link: link.href });
}

async function runSchemaGenerator(
  options: SchemaGeneratorOptions,
): Promise<void> {
  const [{ schema }, { printSchema }] = await Promise.all([
    import("@drfed/graphql/schema"),
    import("graphql"),
  ]);
  const schemaCode = printSchema(schema);
  if (options.outputFile === "-") {
    // oxlint-disable-next-line no-console
    console.log(schemaCode);
    return;
  }
  await writeFile(options.outputFile, schemaCode, { encoding: "utf-8" });
}

export async function main(): Promise<void> {
  const invocation = createProgram({
    mode: selectInvocationMode(process.argv.slice(2)),
  });
  let options: Options;
  try {
    const raw = await run(invocation.program, {
      contexts: invocation.contexts,
      contextOptions: {
        load: (parsed) =>
          parsed.mode[0] === "schema" ? undefined : invocation.load(parsed),
      },
      help: "option",
      completion: "both",
      showChoices: true,
      showDefault: true,
      version: {
        option: true,
        value: metadata.version,
      },
    });
    options = resolveOptions(raw);
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
  if ("generateGraphqlSchema" in options) {
    await runSchemaGenerator(options);
    return;
  }
  if (options.printConfig) {
    console.log(JSON.stringify(describeServerConfiguration(options), null, 2));
    return;
  }
  let loggingConfig: Awaited<ReturnType<typeof createLoggingConfig>>;
  try {
    loggingConfig = await createLoggingConfig(
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
  } catch {
    printError([
      text("Could not initialize logging; check the log output path."),
    ]);
    process.exitCode = 1;
    return;
  }
  await configure(loggingConfig);

  await runServer(options);
}
