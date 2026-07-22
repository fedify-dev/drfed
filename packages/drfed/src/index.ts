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

import { createYogaServer } from "@drfed/graphql";
import { schema } from "@drfed/graphql/schema";
import { migrate } from "@drfed/models";
import { configure, getConsoleSink } from "@logtape/logtape";
import { createLoggingConfig } from "@optique/logtape";
import { run } from "@optique/run";
import { SmtpTransport } from "@upyo/smtp";
import { printSchema } from "graphql";
import { serve } from "srvx";

// oxlint-disable-next-line import/no-relative-parent-imports
import metadata from "../package.json" with { type: "json" };
import type {
  Options,
  SchemaGeneratorOptions,
  ServerOptions,
} from "./parser.ts";
import program from "./program.ts";
import seedData from "./seed.ts";

async function runServer(options: ServerOptions) {
  if (options.drizzle.migrate) {
    await migrate({ credentials: options.drizzle.credentials });
  }
  if (options.seed) {
    await seedData(options.drizzle.db);
  }
  const { mailer } = options;
  const yogaServer = createYogaServer(options.drizzle.db, { mailer });
  const server = serve({
    fetch: yogaServer.fetch.bind(yogaServer),
    hostname: options.address.host,
    manual: true,
    port: options.address.port,
  });
  function shutdown() {
    if (mailer instanceof SmtpTransport) {
      mailer.closeAllConnections();
    }
    // oxlint-disable-next-line promise/catch-or-return promise/prefer-await-to-then no-magic-numbers
    server.close().then(() => process.exit(0));
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await server.serve();
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

// oxlint-disable-next-line max-lines-per-function
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
